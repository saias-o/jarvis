import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { tsImport } from 'tsx/esm/api'
import { displayServer } from '../bridge/panels.mjs'

test('display and blade still reach the viewer over MCP, including sticky markup and images', async (t) => {
  const blades = []
  const endpoint = displayServer((blade) => blades.push(blade), { camera: false })
  const client = new Client({ name: 'display-check', version: '1.0.0' })
  const [serverWire, clientWire] = InMemoryTransport.createLinkedPair()
  await endpoint.instance.connect(serverWire)
  await client.connect(clientWire)
  t.after(async () => { await client.close(); await endpoint.instance.close() })

  const html = '<p class="hud-note">Report</p>'
  const shown = await client.callTool({ name: 'display', arguments: { title: 'Report', html, slot: 'wide', hold: 'sticky' } })
  assert.notEqual(shown.isError, true)
  assert.equal(blades[0].kind, 'markup')
  assert.equal(blades[0].html, html)
  assert.equal(blades[0].size, 'wide')
  assert.equal(blades[0].hold, 'sticky')
  const image = await client.callTool({ name: 'blade', arguments: { title: 'Image', kind: 'image', url: 'https://example.com/photo.png' } })
  assert.notEqual(image.isError, true)
  assert.equal(blades[1].kind, 'image')
  assert.equal(blades[1].url, 'https://example.com/photo.png')
  const empty = await client.callTool({ name: 'display', arguments: { title: 'Empty', html: '' } })
  assert.equal(empty.isError, true)
  assert.equal(blades.length, 2)
  const { tools } = await client.listTools()
  assert.ok(!tools.find((tool) => tool.name === 'blade').inputSchema.properties.kind.enum.includes('camera'))
})

test('clearing viewer content preserves the existing sticky and transcript contracts', async (t) => {
  const { useStore } = await tsImport('../src/store.ts', import.meta.url)
  const initial = useStore.getState()
  t.after(() => useStore.setState(initial, true))
  const state = () => useStore.getState()
  const image = { id: 'sticky', title: 'Image', kind: 'image', url: '/photo.png', hold: 'sticky', size: 'full' }
  state().pushBlade(image)
  state().pushBlade({ ...image, id: 'temporary', hold: 'turn' })
  state().pushTurn({ id: 'question', role: 'user', text: 'Hello' })
  state().clearBlades()
  assert.deepEqual(state().blades.map((blade) => blade.id), ['sticky'])
  state().clearScreen('panels')
  assert.equal(state().blades.length, 0)
  assert.equal(state().turns.length, 1)
  state().pushBlade(image)
  state().clearScreen('transcript')
  assert.equal(state().blades.length, 1)
  assert.equal(state().turns.length, 0)
  state().clearScreen('all')
  assert.equal(state().blades.length, 0)
})
