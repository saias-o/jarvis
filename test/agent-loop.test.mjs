import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentTurn } from '../shared/agent-loop.mjs'
import { deviceTools } from '../shared/tools.mjs'

test('invalid model calls cannot invoke the write primitive on either device', async () => {
  let step = 0
  const writes = []
  const tools = deviceTools({ write: (path, content) => { writes.push([path, content]) } })
  const args = ['invalid JSON', [], { path: 'a' }, { path: 'a', content: '' }]
  await agentTurn('write', {
    tools,
    chat: async function* (messages) {
      if (step++ === 0) {
        yield { message: { tool_calls: args.map((arguments_) => ({ function: { name: 'write_file', arguments: arguments_ } })) } }
      } else {
        assert.equal(messages.filter((m) => m.role === 'tool' && m.content.startsWith('That failed:')).length, 3)
        yield { message: { content: 'Done' } }
      }
    },
  })
  assert.deepEqual(writes, [['a', '']])
})

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

test('native reasoning stays within the current tool cycle and out of saved conversation', async () => {
  let step = 0, saved
  await agentTurn('Read the reference.', {
    tools: [{ name: 'read_file', description: '', parameters: {}, run: () => 'REFERENCE' }],
    onMessages: (messages) => { saved = messages },
    chat: async function* (messages) {
      if (step++ === 0) {
        yield { message: { thinking: 'native tool reasoning' } }
        yield { message: { tool_calls: [{ function: { name: 'read_file', arguments: {} } }] } }
      } else {
        assert.equal(messages.at(-2).thinking, 'native tool reasoning')
        assert.equal(messages.at(-1).content, 'REFERENCE')
        yield { message: { content: 'REFERENCE' } }
      }
    },
  })
  assert.ok(saved.every((message) => !('thinking' in message)))
})
