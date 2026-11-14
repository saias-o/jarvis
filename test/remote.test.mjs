// The remote port: who gets in, and what they get.
//
//   node --test test/
//
// Starts the real bridge with remote access on, pointed at a throwaway code
// file and a throwaway interface, so nothing here touches ~/.jarvis or dist.
// As in bridge-network.test.mjs, no agent session is ever started.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))
const NAME = 'pc.example.ts.net'

let dir
let child
let port
let localPort
let code
let log = ''

function call(path, { method = 'GET', headers = {}, body, to = port } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: to, path, method, headers: { host: NAME, ...headers }, timeout: 4000 },
      (res) => {
        const chunks = []
        res.on('data', (d) => chunks.push(d))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          resolve({ status: res.statusCode, headers: res.headers, text: bytes.toString(), bytes })
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end(body)
  })
}

const pair = (given) =>
  call('/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${NAME}` },
    body: JSON.stringify({ code: given }),
  })

function wsHandshake(headers) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port, timeout: 3000 })
    s.once('timeout', () => {
      s.destroy()
      resolve('timeout')
    })
    s.once('connect', () => {
      const lines = [
        'GET / HTTP/1.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ]
      s.write(lines.join('\r\n') + '\r\n\r\n')
    })
    s.once('data', (d) => {
      s.destroy()
      resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(d.toString())?.[1]))
    })
    s.once('error', () => resolve(null))
  })
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-remote-'))
  mkdirSync(join(dir, 'face', 'assets'), { recursive: true })
  writeFileSync(join(dir, 'face', 'index.html'), '<!doctype html><title>face</title>')
  writeFileSync(join(dir, 'face', 'assets', 'app.js'), 'export {}')
  writeFileSync(join(dir, 'secret.txt'), 'not for serving')

  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      JARVIS_BRIDGE_PORT: '0',
      JARVIS_REMOTE_PORT: '0',
      JARVIS_REMOTE_HOSTS: NAME,
      JARVIS_REMOTE_ORIGINS: 'https://jarvis.app',
      JARVIS_REMOTE_USERS: 'owner@example.com',
      JARVIS_REMOTE_FILE: join(dir, 'remote.json'),
      JARVIS_FACE_DIR: join(dir, 'face'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not start: ${log}`)), 15_000)
    const onData = (d) => {
      log += d
      const remote = /remote access listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(log)
      const local = /bridge listening on ws:\/\/\S+:(\d+)/.exec(log)
      if (remote && local) {
        clearTimeout(timer)
        port = Number(remote[1])
        localPort = Number(local[1])
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (c) => {
      clearTimeout(timer)
      reject(new Error(`bridge exited ${c}: ${log}`))
    })
  })
  code = JSON.parse(readFileSync(join(dir, 'remote.json'), 'utf8')).code
})

after(() => {
  child?.kill()
  rmSync(dir, { recursive: true, force: true })
})

test('serves the interface without a code, and nothing outside it', async () => {
  const home = await call('/')
  assert.equal(home.status, 200)
  assert.match(home.text, /face/)
  assert.equal((await call('/assets/app.js')).status, 200)
  // A client-side route is the app; a missing file is a 404, not the app.
  assert.equal((await call('/settings')).status, 200)
  assert.equal((await call('/assets/missing.js')).status, 404)
  for (const escape of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt']) {
    const res = await call(escape)
    assert.ok(!res.text.includes('not for serving'), `${escape} escaped the interface folder`)
  }
})

test('every endpoint is closed until the code has been given', async () => {
  assert.deepEqual(JSON.parse((await call('/auth')).text), { required: true, ok: false })
  for (const path of ['/inference', '/health', '/file?path=/tmp/x.png', '/img?url=https://example.com/a.png', '/page?url=https://example.com']) {
    assert.equal((await call(path)).status, 401, path)
  }
  assert.equal((await call('/tts', { method: 'POST', body: '{"text":"hi"}' })).status, 401)
  // Handing JARVIS a file writes to the computer's disk: not without the code.
  assert.equal((await call('/upload?name=x.txt', { method: 'POST', body: 'x' })).status, 401)
  assert.equal((await call('/inference', { method: 'POST', body: '{}' })).status, 401)
  assert.equal(await wsHandshake({ Host: NAME, Origin: `https://${NAME}` }), 401)
})

test('the code buys a cookie, and the cookie opens everything', async () => {
  // Typed the way a person types it: lower case, with the dash.
  const res = await pair(`${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase())
  assert.equal(res.status, 200)
  const set = String(res.headers['set-cookie'])
  assert.match(set, /HttpOnly/)
  assert.match(set, /SameSite=Strict/)
  assert.match(set, /Secure/)
  const cookie = set.split(';')[0]

  assert.equal((await call('/health', { headers: { cookie } })).status, 200)
  assert.deepEqual(JSON.parse((await call('/auth', { headers: { cookie } })).text), {
    required: true,
    ok: true,
  })
  assert.equal(await wsHandshake({ Host: NAME, Origin: `https://${NAME}`, Cookie: cookie }), 101)
  // The cookie is not a pass for another page's script.
  assert.equal(await wsHandshake({ Host: NAME, Origin: 'https://attacker.example', Cookie: cookie }), 403)
  assert.equal(await wsHandshake({ Host: NAME, Cookie: cookie }), 403)
  assert.equal((await call('/health', { headers: { cookie, origin: 'https://attacker.example' } })).status, 403)
  // Nor a pass on a name nobody configured.
  assert.equal((await call('/health', { headers: { cookie, host: 'attacker.example' } })).status, 403)
  // A forged cookie is just a wrong one.
  assert.equal((await call('/health', { headers: { cookie: 'jarvis_access=' + 'a'.repeat(64) } })).status, 401)
})

test('a signed image URL fetches that image and no other', async () => {
  const { createRemote } = await import('../bridge/remote.mjs')
  const remote = createRemote({ hosts: [NAME], faceDir: join(dir, 'face'), file: join(dir, 'remote.json') })
  const url = 'https://example.invalid/a.png'
  const sig = remote.signImage(url)
  // Past the gate: the proxy itself then fails to resolve the name.
  assert.notEqual((await call(`/img?url=${encodeURIComponent(url)}&sig=${sig}`)).status, 401)
  assert.equal((await call(`/img?url=${encodeURIComponent('https://example.invalid/b.png')}&sig=${sig}`)).status, 401)
  assert.equal((await call(`/health?url=${encodeURIComponent(url)}&sig=${sig}`)).status, 401)
})

test('a PC screenshot is delivered intact through the authenticated mobile media URL', async () => {
  const { mediaUrl } = await tsImport('../src/lib/mediaUrl.ts', import.meta.url)
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/YQAAAAASUVORK5CYII=', 'base64')
  const path = join(dir, 'screen with spaces.png')
  writeFileSync(path, image)
  const source = `http://localhost:8787/file?path=${encodeURIComponent(path)}`
  const mobile = new URL(mediaUrl(source, `https://${NAME}`))
  const route = mobile.pathname + mobile.search
  assert.equal(mobile.origin, `https://${NAME}`)
  assert.equal((await call(route)).status, 401)
  const paired = await pair(code)
  const cookie = String(paired.headers['set-cookie']).split(';')[0]
  const res = await call(route, { headers: { cookie } })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.deepEqual(res.bytes, image)
})

test('the local port is unchanged: no code, and no interface', async () => {
  const headers = { host: `127.0.0.1:${localPort}` }
  assert.equal((await call('/health', { to: localPort, headers })).status, 200)
  assert.deepEqual(JSON.parse((await call('/auth', { to: localPort, headers })).text), {
    required: false,
    ok: true,
  })
  assert.equal((await call('/', { to: localPort, headers })).status, 404)
  assert.equal((await call('/health', { to: localPort })).status, 403) // the remote name means nothing here
})

test('the Android origin needs an owner identity, CORS and a bearer token', async () => {
  const app = { origin: 'https://jarvis.app', 'tailscale-user-login': 'owner@example.com', 'x-forwarded-for': '100.64.0.2' }
  assert.equal((await call('/health', { headers: { origin: app.origin } })).status, 403)
  assert.equal((await call('/health', { headers: { ...app, 'tailscale-user-login': 'guest@example.com' } })).status, 403)
  assert.equal((await call('/health', { headers: app })).status, 401)
  const preflight = await call('/upload', { method: 'OPTIONS', headers: { ...app, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-origin'], app.origin)
  assert.match(preflight.headers['access-control-allow-headers'], /Authorization/)
  const paired = await call('/auth', { method: 'POST', headers: { ...app, 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
  assert.equal(paired.status, 200)
  const token = JSON.parse(paired.text).token
  assert.match(token, /^[a-f0-9]{64}$/)
  const health = await call('/health', { headers: { ...app, authorization: `Bearer ${token}` } })
  assert.equal(health.status, 200)
  assert.equal(health.headers['access-control-allow-origin'], app.origin)
  assert.equal((await call('/health', { headers: { ...app, origin: 'https://attacker.example', authorization: `Bearer ${token}` } })).status, 403)
  assert.equal((await call('/health', { headers: { ...app, origin: 'https://jarvis.app.evil', authorization: `Bearer ${token}` } })).status, 403)
  assert.equal((await call('/health', { headers: { origin: app.origin, authorization: `Bearer ${token}` } })).status, 403)
  assert.equal(await wsHandshake({ ...app, host: NAME, 'Sec-WebSocket-Protocol': `jarvis, jarvis-access.${token}` }), 101)
  assert.equal(await wsHandshake({ origin: app.origin, host: NAME, 'Sec-WebSocket-Protocol': `jarvis, jarvis-access.${token}` }), 403)
})

// Last, because it shuts the door for five minutes.
test('wrong codes lock the door, even against the right one', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await pair('WRONG123')).status, 401)
  assert.equal((await pair('WRONG123')).status, 429)
  assert.equal((await pair(code)).status, 429)
})

// ---------------------------------------------------------------------------
// JARVIS_REMOTE_CODE=off — the Tailscale account is the only key.

const OWNER = 'owner@example.com'

async function startOpen(t) {
  const open = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      JARVIS_BRIDGE_PORT: '0',
      JARVIS_REMOTE_PORT: '0',
      JARVIS_REMOTE_HOSTS: NAME,
      JARVIS_REMOTE_CODE: 'off',
      JARVIS_REMOTE_USERS: OWNER,
      JARVIS_REMOTE_FILE: join(dir, 'never-written.json'),
      JARVIS_FACE_DIR: join(dir, 'face'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => open.kill())
  let out = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not start: ${out}`)), 15_000)
    const onData = (d) => {
      out += d
      const m = /remote access listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    }
    open.stdout.on('data', onData)
    open.stderr.on('data', onData)
  })
}

test('with the code off, the owner\'s Tailscale account is what opens the door', async (t) => {
  const to = await startOpen(t)
  // What tailscale serve adds to a request from one of the owner's devices.
  const viaTailnet = (login) => ({ 'x-forwarded-for': '100.64.0.2', 'tailscale-user-login': login })

  assert.deepEqual(JSON.parse((await call('/auth', { to, headers: viaTailnet(OWNER) })).text), {
    required: false,
    ok: true,
  })
  assert.equal((await call('/health', { to, headers: viaTailnet(OWNER) })).status, 200)
  assert.equal((await call('/health', { to, headers: viaTailnet('Owner@Example.com') })).status, 200)

  // Somebody else on the tailnet, and a proxied request that names nobody.
  assert.equal((await call('/health', { to, headers: viaTailnet('guest@example.com') })).status, 403)
  assert.equal((await call('/', { to, headers: viaTailnet('guest@example.com') })).status, 403)
  assert.equal((await call('/health', { to, headers: { 'x-forwarded-for': '100.64.0.3' } })).status, 403)

  // The rules that never depended on the code still hold without it.
  assert.equal((await call('/health', { to, headers: { ...viaTailnet(OWNER), host: 'attacker.example' } })).status, 403)
  assert.equal(
    (await call('/health', { to, headers: { host: 'attacker.example', 'x-forwarded-host': NAME } })).status,
    403,
    'a forwarded name must not stand in for Host',
  )
  assert.equal(
    (await call('/health', { to, headers: { ...viaTailnet(OWNER), origin: 'https://attacker.example' } })).status,
    403,
  )

  // No code means no code file.
  assert.throws(() => readFileSync(join(dir, 'never-written.json')))
})
