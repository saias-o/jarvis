// The local brain and the rules for falling back to it.
//
//   node --test test/
//
// A fake Ollama stands in for the real one: a few lines of HTTP that answer
// /api/tags and stream /api/chat the way Ollama does. No model is loaded and
// nothing here needs Ollama installed.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLocal, localConfig } from '../bridge/local.mjs'
import { brainMode, createHealth, createProbe, resetTime, unavailable } from '../bridge/router.mjs'

let server
let url
/** What the fake should stream for each successive /api/chat call. */
let script = []
/** Every /api/chat body received, in order. */
let asked = []
let models = ['gemma4:e2b']
let rejectThink = false

before(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ models: models.map((name) => ({ name, model: name })) }))
    }
    if (req.url === '/api/chat') {
      let body = ''
      for await (const chunk of req) body += chunk
      const parsed = JSON.parse(body)
      if (rejectThink && 'think' in parsed) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'this model does not support thinking (think)' }))
      }
      asked.push(parsed)
      const chunks = script.shift() ?? [{ message: { content: 'Nothing scripted.' } }]
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      // Written in awkward pieces on purpose: a line split across two writes
      // is what a real network does to a stream.
      const wire = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n' + JSON.stringify({ done: true }) + '\n'
      const cut = Math.floor(wire.length / 2)
      res.write(wire.slice(0, cut))
      await new Promise((r) => setTimeout(r, 5))
      return res.end(wire.slice(cut))
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

const fresh = (env = {}) => {
  script = []
  asked = []
  return createLocal(localConfig({ JARVIS_LOCAL_URL: url, ...env }))
}

test('the defaults are a small model on this machine', () => {
  const config = localConfig({})
  assert.equal(config.model, 'gemma4:e2b')
  assert.deepEqual(config.urls, ['http://127.0.0.1:11434'])
  assert.equal(config.ctx, 8192)
})

test('several Ollama addresses are tried in order', async () => {
  const local = createLocal(
    localConfig({ JARVIS_LOCAL_URL: `http://127.0.0.1:9/, ${url}/` }),
  )
  assert.equal(await local.available(), true)
})

test('a model that has not been pulled is reported, with the command that fixes it', async () => {
  const local = fresh({ JARVIS_LOCAL_MODEL: 'gemma4:26b' })
  assert.equal(await local.available(), false)
  assert.match(await local.problem(), /ollama pull gemma4:26b/)
})

test('an untagged model name matches :latest', async () => {
  models = ['llama9:latest']
  try {
    assert.equal(await fresh({ JARVIS_LOCAL_MODEL: 'llama9' }).available(), true)
  } finally {
    models = ['gemma4:e2b']
  }
})

test('text is streamed as it arrives and returned whole', async () => {
  const local = fresh()
  script.push([{ message: { content: 'Good ' } }, { message: { content: 'evening, sir.' } }])
  const heard = []
  const text = await local.turn('hello', { system: 'be brief', onText: (d) => heard.push(d) })
  assert.equal(text, 'Good evening, sir.')
  assert.deepEqual(heard, ['Good ', 'evening, sir.'])
  assert.equal(asked[0].model, 'gemma4:e2b')
  assert.equal(asked[0].think, undefined)
  assert.equal(asked[0].options.num_ctx, 8192)
  assert.deepEqual(asked[0].messages.map((m) => m.role), ['system', 'user'])
})

test('earlier exchanges are given as history', async () => {
  const local = fresh()
  script.push([{ message: { content: 'Paris.' } }])
  await local.turn('and its capital?', {
    system: 's',
    history: [{ user: 'tell me about France', jarvis: 'A country in Europe.' }],
  })
  assert.deepEqual(
    asked[0].messages.map((m) => [m.role, m.content]),
    [
      ['system', 's'],
      ['user', 'tell me about France'],
      ['assistant', 'A country in Europe.'],
      ['user', 'and its capital?'],
    ],
  )
})

test('a tool call is run and its result goes back to the model', async () => {
  const local = fresh()
  script.push([
    { message: { content: '', tool_calls: [{ function: { name: 'add', arguments: { a: 2, b: 3 } } }] } },
  ])
  script.push([{ message: { content: 'Five, sir.' } }])
  const announced = []
  const text = await local.turn('two plus three', {
    system: 's',
    tools: [
      {
        name: 'add',
        description: 'adds',
        parameters: { type: 'object', properties: {}, required: [] },
        run: async ({ a, b }) => String(a + b),
      },
    ],
    onTool: (name) => announced.push(name),
  })
  assert.equal(text, 'Five, sir.')
  assert.deepEqual(announced, ['add'])
  assert.equal(asked[0].tools[0].function.name, 'add')
  const reply = asked[1].messages.at(-1)
  assert.deepEqual(reply, { role: 'tool', tool_name: 'add', content: '5' })
})

test('a tool that throws, or does not exist, is reported to the model rather than ending the turn', async () => {
  const local = fresh()
  script.push([
    {
      message: {
        tool_calls: [
          { function: { name: 'explode', arguments: '{}' } },
          { function: { name: 'imaginary', arguments: {} } },
        ],
      },
    },
  ])
  script.push([{ message: { content: 'That did not work.' } }])
  const text = await local.turn('try', {
    system: 's',
    tools: [
      {
        name: 'explode',
        description: 'fails',
        parameters: { type: 'object', properties: {} },
        run: async () => {
          throw new Error('boom')
        },
      },
    ],
  })
  assert.equal(text, 'That did not work.')
  const results = asked[1].messages.filter((m) => m.role === 'tool').map((m) => m.content)
  assert.match(results[0], /boom/)
  assert.match(results[1], /no tool called imaginary/)
})

test('the last step offers no tools, so the model has to answer', async () => {
  const local = fresh()
  const again = [{ message: { tool_calls: [{ function: { name: 'spin', arguments: {} } }] } }]
  script.push(again, again, [{ message: { content: 'Enough.' } }])
  const text = await local.turn('loop', {
    system: 's',
    maxSteps: 3,
    tools: [{ name: 'spin', description: 'spins', parameters: { type: 'object', properties: {} }, run: async () => 'spun' }],
  })
  assert.equal(text, 'Enough.')
  assert.equal(asked.length, 3)
  assert.ok(asked[0].tools && asked[1].tools)
  assert.equal(asked[2].tools, undefined)
})

test('reasoning stays at the model default, including models that reject a think override', async () => {
  rejectThink = true
  try {
    const local = fresh()
    script.push([{ message: { content: 'One.' } }], [{ message: { content: 'Two.' } }])
    assert.equal(await local.turn('a', { system: 's' }), 'One.')
    assert.equal(await local.turn('b', { system: 's' }), 'Two.')
    assert.ok(asked.every((body) => !('think' in body)))
  } finally {
    rejectThink = false
  }
})

test('an aborted turn rejects instead of answering', async () => {
  const local = fresh()
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(local.turn('never', { system: 's', signal: abort.signal }))
})

test('with nothing to talk to, a turn fails with the reason', async () => {
  const local = createLocal(localConfig({ JARVIS_LOCAL_URL: 'http://127.0.0.1:9' }))
  assert.equal(await local.available(), false)
  await assert.rejects(local.turn('hello', { system: 's' }), /no Ollama answering/)
})

// ---------------------------------------------------------------------------
// When to fall back
// ---------------------------------------------------------------------------

test('JARVIS_BRAIN accepts three values and treats anything else as auto', () => {
  assert.equal(brainMode('local'), 'local')
  assert.equal(brainMode(' Claude '), 'claude')
  assert.equal(brainMode(undefined), 'auto')
  assert.equal(brainMode('locl'), 'auto')
})

test('only errors that mean Claude is out of reach count as unavailable', () => {
  for (const error of ['rate_limit', 'authentication_failed', 'billing_error', 'overloaded', 'server_error']) {
    assert.equal(unavailable(error), true, error)
  }
  // About one request, not about Claude: a second brain would not help.
  for (const error of ['invalid_request', 'max_output_tokens', undefined, null]) {
    assert.equal(unavailable(error), false, String(error))
  }
})

test('Claude is left alone for a while after failing, then tried again', () => {
  let clock = 1_000_000
  const health = createHealth(() => clock)
  assert.equal(health.down(), false)
  health.markDown('overloaded')
  assert.equal(health.down(), true)
  assert.equal(health.reason(), 'overloaded')
  clock += 61_000
  assert.equal(health.down(), false)
  assert.equal(health.reason(), null)
})

test('a usage limit waits for its reset, but never for hours on its say-so', () => {
  let clock = 1_000_000
  const health = createHealth(() => clock)
  health.markDown('rate_limit', clock + 2 * 60_000)
  assert.equal(health.until(), clock + 2 * 60_000)
  health.markDown('rate_limit', clock + 5 * 60 * 60_000)
  assert.equal(health.until(), clock + 15 * 60_000)
  health.markUp()
  assert.equal(health.down(), false)
})

test('reset times are read in seconds or milliseconds', () => {
  assert.equal(resetTime(1_800_000_000), 1_800_000_000_000)
  assert.equal(resetTime(1_800_000_000_000), 1_800_000_000_000)
  assert.equal(resetTime(undefined), null)
})

test('the network probe remembers its answer and asks once at a time', async () => {
  let clock = 0
  let dials = 0
  let up = true
  const reachable = createProbe({
    dial: async () => {
      dials++
      return up
    },
    now: () => clock,
    env: {},
  })
  assert.deepEqual(await Promise.all([reachable(), reachable()]), [true, true])
  assert.equal(dials, 1)
  clock += 10_000
  assert.equal(await reachable(), true)
  assert.equal(dials, 1, 'still fresh')
  clock += 30_000
  up = false
  assert.equal(await reachable(), false)
  clock += 9_000
  up = true
  assert.equal(await reachable(), true, 'a bad answer is rechecked sooner')
  assert.equal(dials, 3)
})

test('behind a proxy the probe proves nothing, so it always says yes', async () => {
  const reachable = createProbe({ dial: async () => false, env: { HTTPS_PROXY: 'http://proxy:3128' } })
  assert.equal(await reachable(), true)
})

// ---------------------------------------------------------------------------
// The local model's tools
// ---------------------------------------------------------------------------

test('the file tools stay inside their folders and refuse credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-local-'))
  const memory = join(dir, 'memory.md')
  process.env.JARVIS_MEMORY_FILE = memory
  // Imported here so the memory file above is the one it uses.
  const { localSystemPrompt, localTools } = await import('../bridge/local-tools.mjs')
  try {
    const root = join(dir, 'files')
    mkdirSync(root)
    writeFileSync(join(root, 'note.txt'), 'x'.repeat(6000))
    writeFileSync(join(root, '.env'), 'SECRET=1')
    writeFileSync(join(dir, 'outside.txt'), 'no')

    const shown = []
    const tools = localTools({ allowWrites: true, cwd: root, roots: [root], show: (b) => shown.push(b) })
    const run = (name, args) => tools.find((t) => t.name === name).run(args)
    assert.equal(tools.some((t) => t.name === 'run_command'), false, 'no shell unless asked for')
    assert.equal(
      localTools({ allowWrites: false, cwd: root, roots: [root] }).some((t) => t.name === 'write_file'),
      false,
      'no writing in read-only mode',
    )

    assert.match(await run('list_files', { folder: root }), /note\.txt \(6000 bytes\)/)
    const first = await run('read_file', { path: join(root, 'note.txt') })
    assert.match(first, /1000 more characters; read on with from=5000/)
    assert.equal(await run('read_file', { path: join(root, 'note.txt'), from: 5000 }), 'x'.repeat(1000))

    await assert.rejects(run('read_file', { path: join(dir, 'outside.txt') }), /outside the folders/)
    await assert.rejects(run('read_file', { path: join(root, '.env') }), /credentials/)
    await assert.rejects(run('write_file', { path: join(dir, 'escape.txt'), content: 'x' }), /outside the folders/)

    await run('write_file', { path: join(root, 'made', 'new.txt'), content: 'hello' })
    await run('move_file', { from: join(root, 'made', 'new.txt'), to: join(root, 'moved.txt') })
    assert.equal(readFileSync(join(root, 'moved.txt'), 'utf8'), 'hello')
    await assert.rejects(
      run('move_file', { from: join(root, 'moved.txt'), to: join(root, 'note.txt') }),
      /already there/,
    )

    await run('show', { title: 'List', text: 'one <b>\ntwo' })
    assert.equal(shown[0].html, '<p>one &#60;b&#62;</p><p>two</p>')

    assert.equal(await run('remember', { fact: 'Their dog is called Rex.' }), 'Remembered.')
    assert.match(readFileSync(memory, 'utf8'), /Rex/)
    assert.match(localSystemPrompt({ language: 'French', roots: [root] }), /ALWAYS ANSWER IN FRENCH[\s\S]*Rex/)
    assert.equal(await run('forget', { match: 'rex' }), 'Forgot 1 fact(s).')
  } finally {
    delete process.env.JARVIS_MEMORY_FILE
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the PC\'s local model reads the core tools and loads a group only when it asks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-groups-'))
  try {
    const { localTools, localToolGroups } = await import('../bridge/local-tools.mjs')
    const ops = []
    const tools = localTools({ cwd: dir, roots: [dir], allowWrites: true, shell: true, show: () => {}, ui: (op) => ops.push(op) })
    const grouped = localToolGroups(tools)
    const local = fresh()
    asked.length = 0
    script.push([{ message: { content: '', tool_calls: [{ function: { name: 'select_tools', arguments: { group: 'interface' } } }] } }])
    script.push([{ message: { content: '', tool_calls: [{ function: { name: 'ui_effect', arguments: { kind: 'pulse' } } }] } }])
    script.push([{ message: { content: 'Done, sir.' } }])
    const text = await local.turn('flash the screen', { system: `s\n${grouped.prompt}`, tools: [...tools, grouped.selector], offer: grouped.offer })
    assert.equal(text, 'Done, sir.')
    const sent = (i) => asked[i].tools.map((tool) => tool.function.name)
    assert.ok(sent(0).includes('read_file') && sent(0).includes('select_tools') && !sent(0).includes('ui_effect') && !sent(0).includes('display'))
    assert.ok(sent(1).includes('ui_effect') && sent(1).includes('show') && !sent(1).includes('read_file'))
    assert.deepEqual(ops, ['effect'])
    assert.match(asked[0].messages[0].content, /More tools, loaded with select_tools: display = /)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
