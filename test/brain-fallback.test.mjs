// A whole question through the real bridge, answered by the local model.
//
//   node --test test/
//
// The other bridge tests stop short of a conversation because a conversation
// needs Claude. This one does not: a fake Ollama plays the local model, and
// the bridge is run once with JARVIS_BRAIN=local and once in `auto` with a
// "Claude" that dies on start — a script that exits — so the fallback itself
// is what answers. Nothing here reaches Anthropic or needs Ollama installed.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))
const ORIGIN = 'http://localhost:5173'

let dir
let ollama
let ollamaUrl
/** Bodies of every /api/chat call the fake received. */
let asked = []
/** Set to hold the next answer open until released. */
let gate = null
let replies = []
const bridges = []

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-brain-'))
  ollama = createServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ models: [{ name: 'gemma4:e2b' }] }))
    }
    if (req.url === '/api/chat') {
      let body = ''
      for await (const chunk of req) body += chunk
      asked.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      if (replies.length) return res.end(JSON.stringify({ message: replies.shift() }) + '\n' + JSON.stringify({ done: true }) + '\n')
      res.write(JSON.stringify({ message: { content: 'Local ' } }) + '\n')
      if (gate) await gate
      res.write(JSON.stringify({ message: { content: 'answer, sir.' } }) + '\n')
      return res.end(JSON.stringify({ done: true }) + '\n')
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve))
  ollamaUrl = `http://127.0.0.1:${ollama.address().port}`
})

after(() => {
  for (const b of bridges) b.child.kill()
  ollama.close()
  rmSync(dir, { recursive: true, force: true })
})

function startBridge(name, env) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      JARVIS_BRIDGE_PORT: '0',
      JARVIS_REMOTE_PORT: '',
      JARVIS_WORKSPACE: join(dir, name),
      JARVIS_INBOX: '',
      JARVIS_MEMORY_FILE: join(dir, `${name}-memory.md`),
      JARVIS_LOCAL_URL: ollamaUrl,
      JARVIS_LOCAL_MODEL: 'gemma4:e2b',
      JARVIS_MCP_SERVERS: '',
      JARVIS_LANGUAGE: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const bridge = { child, log: '' }
  bridges.push(bridge)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not start: ${bridge.log}`)), 15_000)
    const onData = (d) => {
      bridge.log += d
      const m = /bridge listening on ws:\/\/\S+:(\d+)/.exec(bridge.log)
      if (m && !bridge.port) {
        bridge.port = Number(m[1])
        clearTimeout(timer)
        resolve(bridge)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => reject(new Error(`bridge exited ${code}: ${bridge.log}`)))
  })
}

/** Open the agent socket and collect every frame it sends. */
async function open(bridge) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: ORIGIN })
  const frames = []
  const waiters = []
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString())
    frames.push(frame)
    for (const w of [...waiters]) w()
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const until = (match, ms = 15_000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const hit = frames.find(match)
        if (!hit) return false
        clearTimeout(timer)
        waiters.splice(waiters.indexOf(check), 1)
        resolve(hit)
        return true
      }
      const timer = setTimeout(
        () => reject(new Error(`no such frame; got ${JSON.stringify(frames)}\n${bridge.log}`)),
        ms,
      )
      if (!check()) waiters.push(check)
    })
  return { ws, frames, until, send: (msg) => ws.send(JSON.stringify(msg)) }
}

test('JARVIS_BRAIN=local answers on the machine and says so', async () => {
  asked = []
  const bridge = await startBridge('local', { JARVIS_BRAIN: 'local' })
  const face = await open(bridge)

  const brain = await face.until((f) => f.type === 'brain')
  assert.equal(brain.brain, 'local')
  assert.equal(brain.model, 'gemma4:e2b')

  face.send({ type: 'ask', text: 'hello', id: 'a1' })
  const done = await face.until((f) => f.type === 'done')
  assert.equal(done.text, 'Local answer, sir.')
  assert.equal(done.ask, 'a1')
  assert.deepEqual(
    face.frames.filter((f) => f.type === 'text').map((f) => [f.delta, f.ask]),
    [
      ['Local ', 'a1'],
      ['answer, sir.', 'a1'],
    ],
  )

  // The second question carries the first exchange: the model keeps nothing
  // itself, so the bridge is what remembers the conversation.
  face.send({ type: 'ask', text: 'and again', id: 'a2' })
  await face.until((f) => f.type === 'done' && f.ask === 'a2')
  assert.deepEqual(
    asked[1].messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'user'],
  )
  assert.equal(asked[1].messages[2].content, 'Local answer, sir.')
  face.ws.close()
})

test('a dropped file is named to the model by the bridge, and only if it is really in the inbox', async () => {
  const bridge = bridges[0]
  const upload = await new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: bridge.port, path: '/upload?name=notes.txt', method: 'POST' },
      (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => resolve(JSON.parse(body)))
      },
    )
    req.on('error', reject)
    req.end('remember the milk')
  })
  const stray = join(dir, 'stray.txt')
  writeFileSync(stray, 'never dropped')

  asked = []
  const face = await open(bridge)
  face.send({ type: 'ask', text: 'what is this?', id: 'f1', files: [upload.path, stray] })
  await face.until((f) => f.type === 'done' && f.ask === 'f1')
  const question = asked[0].messages.at(-1).content
  assert.ok(question.startsWith(`[Dropped file: ${upload.path} | 17 B]\n`), question)
  assert.ok(question.endsWith('what is this?'))
  assert.ok(!question.includes('stray'), 'a path outside the inbox was passed on')
  assert.ok(asked[0].tools.some((t) => t.function.name === 'read_file'))
  face.ws.close()
})

test('an interrupt stops the local answer, and the next question is answered', async () => {
  const bridge = bridges[0]
  const face = await open(bridge)
  let release
  gate = new Promise((resolve) => {
    release = resolve
  })
  face.send({ type: 'ask', text: 'long one', id: 'i1' })
  await face.until((f) => f.type === 'text' && f.ask === 'i1')
  face.send({ type: 'interrupt' })
  gate = null
  face.send({ type: 'ask', text: 'short one', id: 'i2' })
  release()
  await face.until((f) => f.type === 'done' && f.ask === 'i2')
  assert.equal(face.frames.some((f) => f.type === 'done' && f.ask === 'i1'), false)
  // Compared whole so that a failure names the error and the bridge's own log.
  assert.deepEqual(face.frames.filter((f) => f.type === 'error'), [], bridge.log.slice(-2000))
  face.ws.close()
})

test('in auto, a Claude that cannot start is replaced by the local model', async () => {
  // A stand-in for the CLI that dies at once — what a missing or broken
  // install looks like to the bridge.
  const broken = join(dir, 'broken-claude.mjs')
  writeFileSync(broken, 'process.exit(1)\n')
  asked = []
  const bridge = await startBridge('auto', {
    JARVIS_BRAIN: 'auto',
    JARVIS_CLAUDE_EXECUTABLE: broken,
  })
  const face = await open(bridge)
  face.send({ type: 'ask', text: 'are you there', id: 'c1' })
  const done = await face.until((f) => f.type === 'done' && f.ask === 'c1', 30_000)
  assert.equal(done.text, 'Local answer, sir.')
  const brain = face.frames.find((f) => f.type === 'brain')
  assert.equal(brain?.brain, 'local')
  // The socket stayed open: the conversation survived the session.
  assert.equal(face.ws.readyState, WebSocket.OPEN)
  face.ws.close()
})

test('in claude-only mode the same failure is reported, as it always was', async () => {
  const bridge = await startBridge('strict', {
    JARVIS_BRAIN: 'claude',
    JARVIS_CLAUDE_EXECUTABLE: join(dir, 'broken-claude.mjs'),
  })
  const face = await open(bridge)
  const closed = new Promise((resolve) => face.ws.once('close', resolve))
  face.send({ type: 'ask', text: 'are you there', id: 's1' })
  await face.until((f) => f.type === 'error', 30_000)
  await closed
  assert.equal(face.frames.some((f) => f.type === 'brain'), false)
})

test('PC tool observations and more than six exchanges survive a new bridge connection', async () => {
  const bridge = await startBridge('continuity', { JARVIS_BRAIN: 'local', JARVIS_ALLOW_WRITES: '1' })
  const path = join(dir, 'continuity', 'context.txt')
  const content = 'x'.repeat(1500) + '\nThe verified reference is SAPPHIRE.'
  writeFileSync(path, content)
  const face = await open(bridge)
  replies = [
    { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path } } }] },
    { content: 'Document lu.' },
  ]
  face.send({ type: 'ask', text: 'Lis le document.', id: 'read' })
  const done = await face.until((f) => f.type === 'done' && f.ask === 'read')
  assert.equal(done.exchange.messages.find((m) => m.role === 'tool').content, content)
  face.ws.close()

  const again = await open(bridge)
  const history = [done.exchange, ...Array.from({ length: 7 }, (_, i) => ({ user: `question ${i}`, jarvis: `réponse ${i}` }))]
  asked = []
  again.send({ type: 'ask', text: 'Quelle référence as-tu lue ?', id: 'follow', history })
  await again.until((f) => f.type === 'done' && f.ask === 'follow')
  assert.equal(asked.length, 1, 'historical calls are context, not actions to replay')
  assert.equal(asked[0].messages.find((m) => m.role === 'tool').content, content)
  assert.ok(asked[0].tools.some((tool) => tool.function.name === 'run_command'))
  assert.match(asked[0].messages[0].content, /Dossier courant/)
  again.ws.close()
})

test('a bridge reconnection restores a confirmed action even when its turn never finished', async () => {
  const bridge = await startBridge('partial', { JARVIS_BRAIN: 'local', JARVIS_ALLOW_WRITES: '1' })
  const face = await open(bridge)
  const path = join(dir, 'partial', 'once.txt')
  const follow = await open(bridge)
  let release
  gate = new Promise((resolve) => { release = resolve })
  try {
    replies = [{ content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path, content: 'saved' } } }] }]
    face.send({ type: 'ask', text: 'save', id: 'save', exchangeId: 'exchange-1' })
    const checkpoint = await face.until((f) => f.type === 'checkpoint' && f.exchange.messages.at(-1).content === 'Written.')
    assert.equal(checkpoint.exchange.id, 'exchange-1')
    assert.equal(readFileSync(path, 'utf8'), 'saved')
    assert.equal(face.frames.some((f) => f.type === 'done'), false)
    face.ws.close()
    release()
    gate = null
    follow.send({ type: 'ask', text: 'where?', id: 'follow', history: [checkpoint.exchange] })
    await follow.until((f) => f.type === 'done')
    const messages = asked.findLast((request) => request.messages.at(-1).content === 'where?').messages
    assert.equal(messages.filter((m) => m.role === 'tool' && m.content === 'Written.').length, 1)
    assert.equal(messages.find((m) => m.tool_calls?.length).tool_calls[0].function.arguments.path, path)
  } finally {
    gate = null
    release()
    follow.ws.close()
    face.ws.close()
  }
})

test('real bridge persists model, tool and viewer traces with conversation identifiers', async () => {
  const logs = join(dir, 'diagnostics')
  const bridge = await startBridge('traced', { JARVIS_BRAIN: 'local', JARVIS_TRACE_DIR: logs, JARVIS_TRACE: '1' })
  const face = await open(bridge)
  const url = 'https://images.example/photo.webp?width=900'
  replies = [
    { content: '', tool_calls: [{ function: { name: 'show', arguments: { image: url } } }] },
    { content: 'Photo affichée.' },
  ]
  face.send({ type: 'ask', text: 'Affiche la photo.', id: 'photo', conversationId: 'trace-conversation' })
  await face.until((f) => f.type === 'done' && f.ask === 'photo')
  face.send({ type: 'trace', event: 'image.error', data: { url, source: '/img?url=example', title: 'Photo' } })
  const records = () => readdirSync(logs).flatMap((file) => readFileSync(join(logs, file), 'utf8').trim().split('\n').map(JSON.parse))
  const deadline = Date.now() + 3000
  while (!records().some((r) => r.event === 'image.error') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  const saved = records()
  for (const event of ['turn.start', 'route.selected', 'model.input', 'tool.start', 'tool.result', 'turn.end', 'image.error']) {
    assert.ok(saved.some((r) => r.event === event && r.conversationId === 'trace-conversation'), event)
  }
  assert.equal(saved.find((r) => r.event === 'tool.start').data.arguments.image, url)
  assert.equal(saved.find((r) => r.event === 'image.error').data.url, url)
  face.ws.close()
})
