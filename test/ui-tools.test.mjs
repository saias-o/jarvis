// The ui_* tools: one definition, the same operations on the phone and the PC.
//
//   node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { androidCatalogue, androidTools } from '../shared/android-agent.mjs'
import { UI_TOOLS, uiTools } from '../shared/ui-tools.mjs'
import { localTools } from '../bridge/local-tools.mjs'

const phoneFiles = {
  status: async () => ({ root: '/storage/emulated/0', inbox: '/phone/inbox', granted: true }),
  readMemory: async () => ({ text: '' }),
}

/** Every call in order, with what each device's interface was handed and what the model was told. */
const CALLS = [
  ['ui_theme', { accent: ' crimson ', background: 'auto', phase_colors: { thinking: '#f00', nonsense: '#0f0', speaking: 'auto' } }],
  ['ui_theme', {}],
  ['ui_reactor', { scale: '0.5', intensity: 9, spin: 'fast', style: 'cube', visible: 'off' }],
  ['ui_orbit', { src: 'C:/renders/suit.png', id: 'suit', radius: '2', phase: 400 }],
  ['ui_orbit', { action: 'remove' }],
  ['ui_orbit', { src: 'https://example.com/a.png' }],
  ['ui_orbit', { action: 'clear' }],
  ['ui_chrome', { systems: 'hide', tool_badge: 1 }],
  ['ui_effect', { kind: 'explode' }],
  ['ui_screen', { what: 'panels' }],
  ['ui_reset', {}],
]

async function play(tools, ops) {
  const told = []
  for (const [name, args] of CALLS) {
    try { told.push(await tools.find((tool) => tool.name === name).run(args)) }
    catch (error) { told.push(`error: ${error.message}`) }
  }
  return { told, ops }
}

test('the phone and the PC redress the interface with the same operations and answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-ui-'))
  try {
    const phoneOps = [], pcOps = []
    const phone = await androidTools(phoneFiles, { ui: (op, args) => { phoneOps.push([op, args]) } })
    const pc = localTools({ cwd: dir, roots: [dir], ui: (op, args) => { pcOps.push([op, args]) } })
    const onPhone = await play(phone.tools, phoneOps)
    const onPc = await play(pc, pcOps)
    assert.deepEqual(onPhone, onPc)

    assert.deepEqual(onPhone.told, [
      'Interface retinted.', 'No change — no colours were given.', 'Reactor adjusted.', 'In orbit as "suit".',
      'error: Not removed: remove needs the id the object was added with. Use action "clear" to take them all down.',
      'error: Not added: remote images are blocked by the page. Orbit a file you generated, rendered or captured instead.',
      'Orbits cleared.', 'Chrome updated.', 'Fired.', 'Cleared.', 'Interface restored.',
    ])
    // Forgiving arguments become values the store accepts, or are dropped.
    assert.deepEqual(onPhone.ops, [
      ['patch', { accent: 'crimson', background: null, palette: { thinking: '#f00' } }],
      ['patch', { reactor: { scale: 0.5, intensity: 3, visible: false } }],
      ['orbit', { action: 'add', id: 'suit', src: 'C:/renders/suit.png', radius: 1.2, speed: 4, size: 96, tilt: 24, opacity: 0.9, phase: 40 }],
      ['orbit', { action: 'clear' }],
      ['patch', { chrome: { systems: false, toolBadge: true } }],
      ['effect', { kind: 'pulse' }],
      ['screen', { what: 'panels' }],
      ['reset', {}],
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a device without an interface primitive is offered no ui_* tool', async () => {
  const phone = await androidTools(phoneFiles, {})
  assert.ok(!phone.tools.some((tool) => UI_TOOLS.has(tool.name)))
  assert.deepEqual(uiTools(() => {}).map((tool) => tool.name), [...UI_TOOLS])
})

test('Gemma reaches the interface through its own tool group, even without a PC', async () => {
  const shown = []
  const phone = await androidTools(phoneFiles, { show: () => {}, ui: (op) => { shown.push(op) } })
  const catalogue = androidCatalogue(phone, { tools: [], system: '' })
  const specs = catalogue.tools.map(({ name, description, parameters }) => ({ function: { name, description, parameters } }))
  const offered = () => catalogue.offer(specs, true).map((spec) => spec.function.name)
  assert.ok(offered().includes('select_tools') && !offered().includes('ui_theme'))
  assert.match(catalogue.localSystem(), /interface = couleurs, réacteur/)
  await assert.rejects(catalogue.tools.find((tool) => tool.name === 'select_tools').run({ group: 'pc' }), /pc tools are not available/)
  await catalogue.tools.find((tool) => tool.name === 'select_tools').run({ group: 'interface' })
  assert.deepEqual(offered(), ['show', ...UI_TOOLS, 'select_tools'])
  await catalogue.tools.find((tool) => tool.name === 'ui_effect').run({ kind: 'scan' })
  assert.deepEqual(shown, ['effect'])
  // PC inference reads every group at once and needs no selector.
  assert.ok(!catalogue.offer(specs, false).some((spec) => spec.function.name === 'select_tools'))
})
