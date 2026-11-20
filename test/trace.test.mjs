import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrace, traceData } from '../shared/trace.mjs'
import { fileTrace } from '../bridge/trace.mjs'
import { agentTurn } from '../shared/agent-loop.mjs'
import { tsImport } from 'tsx/esm/api'

test('trace preserves exact public image URLs and removes secrets and binary payloads', () => {
  const url = `https://images.example/photo.webp?size=900&name=${'a'.repeat(500)}`
  const data = traceData({ url, password: 'private', headers: { authorization: 'Bearer private' },
    messages: [{ thinking: 'private reasoning', content: 'visible' }, { type: 'thinking', thinking: 'private' }],
    images: ['a'.repeat(1000)], source: { type: 'base64', data: 'privatebinary' },
    screenshot: { type: 'image', data: 'privatebinary', mimeType: 'image/png' },
    env: 'ELEVENLABS_API_KEY=private JARVIS_REMOTE_CODE=private',
    content: '{"authorization_token":"private"}', error: new Error('Bearer private-token') })
  assert.equal(data.url, url)
  assert.equal(data.messages[0].content, 'visible')
  assert.doesNotMatch(JSON.stringify(data), /private/)
  assert.match(data.images[0], /1000 encoded/)
  assert.equal(traceData('https://user:pass@example.org/a?token=private&width=20').includes('private'), false)
})

test('trace writes in order across child scopes and survives a failed sink', async () => {
  const records = []; const errors = []
  const logger = createTrace({ context: { conversationId: 'c' }, onError: (e) => errors.push(e),
    async write(line) { const record = JSON.parse(line); if (record.event === 'fail') throw Error('disk'); records.push(record) } })
  void logger.record('first', { text: 'hello' })
  void logger.record('fail')
  void logger.child({ turnId: 't' }).record('last')
  await logger.flush()
  assert.deepEqual(records.map((r) => r.event), ['first', 'last'])
  assert.equal(records[1].conversationId, 'c')
  assert.equal(records[1].turnId, 't')
  assert.equal(records[0].sessionId, records[1].sessionId)
  assert.equal(errors.length, 1)
})

test('file traces persist valid JSONL and rotate with a bounded file count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-traces-'))
  try {
    const trace = fileTrace(dir, { maxBytes: 400, maxFiles: 2 })
    for (let i = 0; i < 5; i++) await trace.record('image.error', { index: i, url: 'https://example.org/image.jpg', padding: 'x'.repeat(100) })
    const files = await readdir(dir)
    assert.equal(files.length, 2)
    const lines = (await Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')))).flatMap((s) => s.trim().split('\n').map(JSON.parse))
    assert.ok(lines.some((line) => line.data.index === 4))
    assert.ok(lines.every((line) => line.event === 'image.error'))
  } finally { await rm(dir, { recursive: true }) }
})

test('agent traces actual model context, tool arguments, full outcome and errors', async () => {
  const records = []
  const logger = createTrace({ write: (line) => records.push(JSON.parse(line)) })
  let step = 0
  const result = await agentTurn('show a photo', {
    system: 'system', history: [{ user: 'before', jarvis: 'answer' }],
    trace: (event, data) => logger.record(event, data),
    chat: async function* () {
      if (!step++) yield { message: { tool_calls: [{ function: { name: 'show', arguments: { image: 'https://example.org/photo.webp' } } }] } }
      else yield { message: { content: 'Image failed.' } }
    }, tools: [{ name: 'show', parameters: { type: 'object' }, run() { throw Error('unsupported content type: text/html') } }],
  })
  assert.equal(result, 'Image failed.')
  assert.equal(records[0].data.messages[1].content, 'before')
  const start = records.find((r) => r.event === 'tool.start')
  const end = records.find((r) => r.event === 'tool.result')
  assert.equal(start.data.arguments.image, 'https://example.org/photo.webp')
  assert.equal(start.data.callId, end.data.callId)
  assert.match(end.data.error.message, /text\/html/)
  assert.match(records.filter((r) => r.event === 'model.request')[1].data.messages.at(-1).content, /unsupported content/)
})

/** Just enough of IndexedDB for one object store: requests settle on a later turn, like the real one. */
function fakeIndexedDB() {
  const rows = new Map(); let key = 0; let transactions = 0; let visited = 0
  const later = (fn) => setImmediate(fn)
  const db = {
    createObjectStore() {},
    transaction() {
      transactions++
      let open = 0
      const tx = {
        objectStore: () => store,
        oncomplete: null, onerror: null, onabort: null,
      }
      const settle = () => later(() => { if (open === 0) tx.oncomplete?.() })
      const store = {
        add(value) { rows.set(++key, value); settle() },
        openCursor(_range, direction = 'next') {
          open++
          const request = { onsuccess: null, result: null }
          const keys = [...rows.keys()].sort((a, b) => direction === 'prev' ? b - a : a - b)
          let at = 0
          const step = () => later(() => {
            while (at < keys.length && !rows.has(keys[at])) at++
            if (at >= keys.length) { request.result = null; request.onsuccess?.(); open--; settle(); return }
            const k = keys[at++]
            visited++
            let moved = false
            request.result = { value: rows.get(k), delete: () => rows.delete(k), continue: () => { moved = true; step() } }
            request.onsuccess?.()
            if (!moved) { open--; settle() }
          })
          step()
          return request
        },
      }
      return tx
    },
  }
  const factory = {
    open() {
      const request = { result: db }
      later(() => { request.onupgradeneeded?.(); request.onsuccess?.() })
      return request
    },
  }
  return { factory, rows, stats: () => ({ transactions, visited }) }
}

test('browser traces keep the newest lines within the byte budget and count instead of walking', async () => {
  const { browserTraceStore } = await tsImport('../src/lib/browserTrace.ts', import.meta.url)
  const idb = fakeIndexedDB()
  // A journal already filled by an earlier page: 50 lines of 10 bytes.
  for (let i = 0; i < 50; i++) idb.rows.set(-1000 + i, { line: `old-${String(i).padStart(4, '0')}\n`, bytes: 10 })
  const write = browserTraceStore(idb.factory, 300)
  await write('new-0001\n')
  const counted = idb.stats().visited
  assert.ok(counted >= 50, 'the first line counts what earlier pages left')
  let total = [...idb.rows.values()].reduce((sum, row) => sum + row.bytes, 0)
  assert.ok(total <= 300)
  for (let i = 2; i <= 40; i++) await write(`new-${String(i).padStart(4, '0')}\n`)
  const lines = [...idb.rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row.line.trim())
  total = [...idb.rows.values()].reduce((sum, row) => sum + row.bytes, 0)
  assert.ok(total <= 300 && total > 280, `within budget and nearly full: ${total}`)
  assert.equal(lines.at(-1), 'new-0040', 'newest kept')
  assert.ok(lines.every((line, i) => i === 0 || line > lines[i - 1]), 'order kept')
  // Later lines visit only the rows they purge, not the whole journal.
  assert.ok(idb.stats().visited - counted < 39 * 3, `visited ${idb.stats().visited - counted} rows for 39 lines`)
})

test('switched-off traces serialize nothing', async () => {
  const { noTrace } = await import('../shared/trace.mjs')
  let read = 0
  const data = { get messages() { read++; return [] } }
  await noTrace.child({ turnId: 't' }).record('model.request', data)
  await noTrace.flush()
  assert.equal(read, 0)
})

test('file traces write lines in order without blocking, and recreate a removed folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-traces-'))
  try {
    const trace = fileTrace(join(dir, 'logs'), { maxBytes: 4096, maxFiles: 3 })
    for (let i = 0; i < 20; i++) void trace.record('step', { i })
    await trace.flush()
    await rm(join(dir, 'logs'), { recursive: true })
    await trace.record('step', { i: 20 })
    await trace.record('step', { i: 21 })
    const files = await readdir(join(dir, 'logs'))
    const lines = (await Promise.all(files.map((file) => readFile(join(dir, 'logs', file), 'utf8')))).flatMap((s) => s.trim().split('\n').map(JSON.parse))
    assert.deepEqual(lines.map((line) => line.data.i).filter((i) => i >= 20), [20, 21], 'the folder is made again, no line lost')
  } finally { await rm(dir, { recursive: true, force: true }) }
})