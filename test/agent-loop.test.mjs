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
