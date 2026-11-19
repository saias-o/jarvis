// look and watch: one definition; the frame reaches the model, never the history.
//
//   node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentTurn } from '../shared/agent-loop.mjs'
import { androidTools } from '../shared/android-agent.mjs'
import { CAMERA_TOOLS } from '../shared/camera-tools.mjs'
import { localTools } from '../bridge/local-tools.mjs'
import { sdkDeviceTools } from '../bridge/device-server.mjs'

const FRAME = 'iVBORw0KGgo='

test('a frame from look reaches the local model with the result, and is not kept in history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-camera-'))
  try {
    const asked = []
    const tools = localTools({ cwd: dir, roots: [dir], capture: async (request) => { asked.push(request); return { data: FRAME, mimeType: 'image/png' } } })
    let seen
    let saved
    const answer = await agentTurn('Que tiens-je ?', {
      tools,
      onMessages: (messages) => { saved = messages },
      async *chat(messages) {
        const last = messages.at(-1)
        if (last.role !== 'tool') { yield { message: { tool_calls: [{ function: { name: 'look', arguments: { reason: 'what you hold' } } }] } }; return }
        seen = last
        yield { message: { content: 'Une tasse.' } }
      },
    })
    assert.equal(answer, 'Une tasse.')
    assert.deepEqual(asked, [{ mode: 'look', reason: 'what you hold' }])
    assert.deepEqual(seen.images, [FRAME])
    assert.equal(seen.content, 'One frame from the camera:')
    assert.ok(!JSON.stringify(saved).includes(FRAME))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Claude receives the frame as image content, and a refusal as a sentence it can pass on', async () => {
  let reply = { data: FRAME, mimeType: 'image/png' }
  const asked = []
  const tools = localTools({ cwd: process.cwd(), roots: [process.cwd()], capture: async (request) => { asked.push(request); return reply } })
  const sdk = sdkDeviceTools(tools.filter((tool) => CAMERA_TOOLS.has(tool.name)))
  const look = await sdk.find((tool) => tool.name === 'look').handler({}, {})
  assert.deepEqual(look.content, [{ type: 'text', text: 'One frame from the camera:' }, { type: 'image', data: FRAME, mimeType: 'image/png' }])
  await sdk.find((tool) => tool.name === 'watch').handler({ seconds: '40', when: 'past' }, {})
  assert.deepEqual(asked.at(-1), { mode: 'watch', seconds: 15, when: 'past', reason: '' })
  reply = { error: 'The camera is not permitted, so I cannot see anything.' }
  const denied = await sdk.find((tool) => tool.name === 'look').handler({}, {})
  assert.equal(denied.isError, true)
  assert.equal(denied.content[0].text, 'The camera is not permitted, so I cannot see anything.')
})

test('a device whose models cannot see images is not offered the camera', async () => {
  const phone = await androidTools({ status: async () => ({ root: '/s', inbox: '/i', granted: true }), readMemory: async () => ({ text: '' }) }, { show: () => {} })
  assert.ok(!phone.tools.some((tool) => CAMERA_TOOLS.has(tool.name)))
})
