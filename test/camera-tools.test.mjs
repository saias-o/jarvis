// look and watch: one definition; the frame reaches the model, never the history.
//
//   node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentTurn } from '../shared/agent-loop.mjs'
import { androidCatalogue, androidChat, androidTools } from '../shared/android-agent.mjs'
import { LOCAL_CONTEXT_BYTES } from '../shared/context-window.mjs'
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

test('the phone offers the camera to PC inference, never to Gemma, and withdraws it on fallback', async () => {
  const phone = await androidTools({
    status: async () => ({ root: '/s', inbox: '/i', granted: true }),
    readMemory: async () => ({ text: '' }),
  }, { show: () => {}, capture: async () => ({ data: FRAME, mimeType: 'image/jpeg' }), context: LOCAL_CONTEXT_BYTES })
  assert.deepEqual(phone.tools.filter((tool) => CAMERA_TOOLS.has(tool.name)).map((tool) => tool.name), ['look', 'watch'])
  // The live view comes with the hardware: same WebView, same camera.
  assert.match(phone.tools.find((tool) => tool.name === 'blade').parameters.properties.kind.enum.join(), /camera/)

  const catalogue = androidCatalogue(phone, { tools: [], system: 'Aucun PC.' })
  const specs = catalogue.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
  const offered = (local) => catalogue.offer(specs, local).map(({ function: fn }) => fn.name)
  assert.ok(offered(false).includes('look') && offered(false).includes('watch'))
  // No group holds the camera, so the phone's own model is never offered it.
  assert.ok(!offered(true).some((name) => CAMERA_TOOLS.has(name)))
  assert.ok(!catalogue.localSystem().includes('look'))

  // A frame obtained while the PC was thinking must not reach Gemma silently.
  let gemmaSaw
  const model = androidChat({
    inference: 'pc', catalogue,
    // Fails before producing anything, as an unreachable PC does.
    remote: () => { throw new Error('PC inference unavailable') },
    async *local(messages) { gemmaSaw = messages; yield { message: { content: 'Je ne vois pas l’image.' } } },
    discover: async () => ({ tools: [], system: '' }),
  })
  const seen = [{ role: 'system', content: 'x' }, { role: 'user', content: 'Que tiens-je ?' },
    { role: 'tool', tool_name: 'look', content: 'One frame from the camera:', images: [FRAME] }]
  for await (const _chunk of model.chat(seen, specs)) { /* drained */ }
  assert.equal(model.source(), 'device')
  const result = gemmaSaw.at(-1)
  assert.equal(result.images, undefined)
  assert.match(result.content, /image non lisible par le modèle du téléphone/)
})
