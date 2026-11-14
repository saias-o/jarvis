import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentTurn } from '../shared/agent-loop.mjs'

test('aborting a streamed answer prevents queued tool side effects', async () => {
  const abort = new AbortController()
  let writes = 0
  const chat = async function* () {
    abort.abort()
    yield { message: { tool_calls: [{ function: { name: 'write', arguments: {} } }] } }
  }
  await assert.rejects(agentTurn('hello', {
    chat, signal: abort.signal,
    tools: [{ name: 'write', parameters: {}, run: () => { writes++ } }],
  }), { name: 'AbortError' })
  assert.equal(writes, 0)
})

test('the last step cannot execute a tool the model was not offered', async () => {
  let writes = 0
  const chat = async function* () {
    yield { message: { tool_calls: [{ function: { name: 'write', arguments: {} } }] } }
  }
  await agentTurn('hello', {
    chat, maxSteps: 1,
    tools: [{ name: 'write', parameters: {}, run: () => { writes++ } }],
  })
  assert.equal(writes, 0)
})

test('existing history retains completed tool observations so a follow-up uses the returned PC path', async () => {
  const pcPath = 'C:/workspace/inbox/received.txt'
  let saved, uploads = 0, moved
  const tools = [
    { name: 'upload_to_pc', parameters: {}, run: () => { uploads++; return JSON.stringify({ path: pcPath }) } },
    { name: 'pc_move_file', parameters: {}, run: (args) => { moved = args; return 'Moved.' } },
  ]
  let step = 0
  const text = await agentTurn('Transfère la pièce jointe sur le PC.', {
    tools, onMessages: (messages) => { saved = messages },
    chat: async function* () {
      yield { message: step++ === 0
        ? { tool_calls: [{ function: { name: 'upload_to_pc', arguments: { path: '/phone/inbox/file.txt' } } }] }
        : { content: 'Fichier reçu sur le PC.' } }
    },
  })
  assert.equal(saved.length, 4)
  let next
  step = 0
  await agentTurn('Range-le dans Images.', {
    history: [{ user: 'Transfère la pièce jointe sur le PC.', jarvis: text, messages: saved }], tools,
    onMessages: (messages) => { next = messages },
    chat: async function* (messages) {
      const received = messages.find((m) => m.role === 'tool' && m.tool_name === 'upload_to_pc')
      assert.equal(JSON.parse(received.content).path, pcPath)
      assert.equal(messages.filter((m) => m.role === 'user' && m.content === 'Transfère la pièce jointe sur le PC.').length, 1)
      yield { message: step++ === 0
        ? { tool_calls: [{ function: { name: 'pc_move_file', arguments: { from: JSON.parse(received.content).path, to: 'C:/Pictures/file.txt' } } }] }
        : { content: 'Fichier rangé.' } }
    },
  })
  assert.equal(uploads, 1)
  assert.deepEqual(moved, { from: pcPath, to: 'C:/Pictures/file.txt' })
  assert.equal(next[0].content, 'Range-le dans Images.')
  assert.ok(!next.some((m) => m.tool_name === 'upload_to_pc'))
})
