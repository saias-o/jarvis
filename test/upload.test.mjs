// Handing JARVIS a file: what the bridge stores, and what it refuses.
//
//   node --test test/
//
// Starts the real bridge with a throwaway workspace, so nothing here touches
// ~/.jarvis. As in the other bridge tests, no agent session is ever started.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createInbox, safeName } from '../bridge/inbox.mjs'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))

let dir
let child
let port
let log = ''

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers, timeout: 5000 },
      (res) => {
        const chunks = []
        res.on('data', (d) => chunks.push(d))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }))
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end(body)
  })
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-upload-'))
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      JARVIS_BRIDGE_PORT: '0',
      JARVIS_WORKSPACE: join(dir, 'workspace'),
      JARVIS_INBOX: '',
      JARVIS_UPLOAD_MAX_MB: '1',
      // No Ollama is looked for, so the log stays about the thing under test.
      JARVIS_BRAIN: 'claude',
      JARVIS_REMOTE_PORT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not start: ${log}`)), 15_000)
    const onData = (d) => {
      log += d
      const m = /bridge listening on ws:\/\/\S+:(\d+)/.exec(log)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (d) => (log += d))
    child.once('exit', (code) => reject(new Error(`bridge exited ${code}: ${log}`)))
  })
})

after(() => {
  child?.kill()
  rmSync(dir, { recursive: true, force: true })
})

test('an uploaded file lands in the inbox, inside the workspace', async () => {
  const res = await post('/upload?name=' + encodeURIComponent('rapport final.txt'), 'bonjour')
  assert.equal(res.status, 200)
  const saved = JSON.parse(res.text)
  assert.equal(saved.name, 'rapport final.txt')
  assert.equal(saved.size, 7)
  assert.equal(readFileSync(saved.path, 'utf8'), 'bonjour')
  const within = relative(join(dir, 'workspace', 'inbox'), saved.path)
  assert.ok(!within.startsWith('..'), `${saved.path} is not in the inbox`)
})

test('a second file of the same name does not replace the first', async () => {
  const a = JSON.parse((await post('/upload?name=twice.txt', 'one')).text)
  const b = JSON.parse((await post('/upload?name=twice.txt', 'two')).text)
  assert.notEqual(a.path, b.path)
  assert.equal(b.name, 'twice (2).txt')
  assert.equal(readFileSync(a.path, 'utf8'), 'one')
})

test('the name cannot place the file anywhere else', async () => {
  const res = await post('/upload?name=' + encodeURIComponent('..\\..\\..\\escape.txt'), 'x')
  const saved = JSON.parse(res.text)
  assert.equal(saved.name, 'escape.txt')
  assert.ok(saved.path.startsWith(join(dir, 'workspace', 'inbox')))
})

test('a file over the limit is refused and leaves nothing behind', async () => {
  const res = await post('/upload?name=big.bin', Buffer.alloc(2 * 1024 * 1024))
  assert.equal(res.status, 413)
  const days = readdirSync(join(dir, 'workspace', 'inbox'))
  for (const day of days) {
    const names = readdirSync(join(dir, 'workspace', 'inbox', day))
    assert.ok(!names.some((n) => n.includes('big') || n.endsWith('.part')), names.join(', '))
  }
})

test('an empty upload is refused', async () => {
  assert.equal((await post('/upload?name=empty.txt', '')).status, 400)
})

test('another site cannot upload', async () => {
  const res = await post('/upload?name=evil.txt', 'x', { origin: 'https://attacker.example' })
  assert.equal(res.status, 403)
})

test('names are reduced to something every filesystem accepts', () => {
  assert.equal(safeName('C:\\Users\\me\\photo.png'), 'photo.png')
  assert.equal(safeName('/etc/passwd'), 'passwd')
  assert.equal(safeName('what?*<>|:".txt'), 'what.txt')
  assert.equal(safeName('.env'), 'env')
  assert.equal(safeName('trailing. . '), 'trailing')
  assert.equal(safeName('CON.txt'), '_CON.txt')
  assert.equal(safeName(''), 'file')
  assert.equal(safeName('..'), 'file')
  const long = safeName('a'.repeat(300) + '.pdf')
  assert.equal(long.length, 120)
  assert.ok(long.endsWith('.pdf'))
})

test('only files really in the inbox are described to the agent', async () => {
  const inbox = createInbox(join(dir, 'box'))
  const req = (async function* () {
    yield Buffer.from('fake png bytes')
  })()
  req.headers = {}
  const saved = await inbox.receive(req, 'picture.png')
  const outside = join(dir, 'outside.txt')
  writeFileSync(outside, 'not dropped')

  const { note, images } = await inbox.describe([saved.path, outside, join(dirname(saved.path), 'missing.txt'), 42])
  assert.equal(note, `[Dropped file: ${saved.path} | 14 B]\n`)
  assert.deepEqual(images, [saved.path])
  assert.deepEqual(await inbox.describe([outside]), { note: '', images: [] })
})
