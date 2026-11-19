import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrace, traceData } from '../shared/trace.mjs'
import { fileTrace } from '../bridge/trace.mjs'
import { agentTurn } from '../shared/agent-loop.mjs'

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
