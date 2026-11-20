// The voice turn's lifecycle and the microphone's: what an interruption, a
// late answer and an app that goes away leave behind.
//
//   node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tsImport } from 'tsx/esm/api'

const { createTurns, FOLLOW_UP_MS } = await tsImport('../src/lib/turns.ts', import.meta.url)
const { createListening, onFirstGesture } = await tsImport('../src/lib/listening.ts', import.meta.url)

/** A store, a model and a speech engine that record what happened to them. */
function harness() {
  const seen = { turns: [], phases: [], errors: [], cancels: 0, speakers: [], timers: new Map(), sounds: [] }
  let timer = 0
  const state = {
    phase: 'dormant',
    setPhase(phase) { state.phase = phase; seen.phases.push(phase) },
    setCaption() {},
    setActiveTool() {},
    setError(message) { if (message) seen.errors.push(message) },
    clearBlades() {},
    pushTurn(turn) { seen.turns.push({ ...turn }) },
    appendToLastTurn(delta) { seen.turns.at(-1).text += delta },
  }
  const asks = []
  const turns = createTurns({
    state: () => state,
    ask: (said, history, handlers) => new Promise((resolve, reject) => asks.push({ said, history: [...history], handlers, resolve, reject })),
    cancel: () => { seen.cancels++ },
    speaker: () => {
      const spk = { said: [], pushed: '', cancelled: false, push(d) { spk.pushed += d }, say(t) { spk.said.push(t) }, end: async () => {}, cancel() { spk.cancelled = true }, level: () => 0.5 }
      seen.speakers.push(spk)
      return spk
    },
    takeFiles: () => [],
    keepHistory: true,
    sounds: { play: (cue) => seen.sounds.push(cue), duck() {} },
    music: { working() {}, duck() {} },
    forTool: (name) => `using ${name}`,
    attention: () => 'Yes?',
    withoutVocative: (text) => text.replace(/^jarvis[, ]*/i, ''),
    newId: () => `id${seen.turns.length}`,
    timers: { set: (fn, ms) => { seen.timers.set(++timer, { fn, ms }); return timer }, clear: (id) => seen.timers.delete(id) },
  })
  return { turns, state, seen, asks }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('an answer is spoken, kept in history, and leaves the mic open for a follow-up', async () => {
  const { turns, state, seen, asks } = harness()
  turns.onWake('what time is it')
  assert.equal(state.phase, 'thinking')
  asks[0].handlers.onTool('clock')
  assert.equal(state.phase, 'tooling')
  assert.deepEqual(seen.speakers[0].said, ['using clock'])
  asks[0].handlers.onText('Nine ')
  asks[0].handlers.onText('o’clock.')
  assert.equal(state.phase, 'speaking')
  asks[0].resolve({ text: 'Nine o’clock.' })
  await settle()
  assert.equal(state.phase, 'listening')
  assert.deepEqual([...seen.timers.values()].map((t) => t.ms), [FOLLOW_UP_MS])
  assert.deepEqual(seen.turns.map((t) => [t.role, t.text]), [['user', 'what time is it'], ['jarvis', 'Nine o’clock.']])

  turns.onUtterance('Jarvis, and tomorrow?')
  assert.equal(asks[1].said, 'and tomorrow?')
  assert.deepEqual(asks[1].history.map((m) => m.content), ['what time is it', 'Nine o’clock.'])
})

test('speaking over an answer cancels it, and its late text never reaches the screen', async () => {
  const { turns, state, seen, asks } = harness()
  turns.sendText('long story')
  asks[0].handlers.onText('Once upon ')
  turns.onSpeechStart()
  assert.equal(seen.cancels, 1)
  assert.equal(seen.speakers[0].cancelled, true)
  assert.equal(state.phase, 'listening')
  asks[0].handlers.onText('a time')
  asks[0].resolve({ text: 'Once upon a time' })
  await settle()
  assert.equal(seen.turns.at(-1).text, 'Once upon ')
  assert.equal(state.phase, 'listening')
  assert.ok(!seen.sounds.includes('done'))
})

test('an app that goes away stops its timers, its speech and the answer in flight', async () => {
  const { turns, state, seen, asks } = harness()
  turns.onWake('')
  assert.equal(seen.timers.size, 1)
  turns.onUtterance('weather')
  asks[0].handlers.onText('Sunny')
  turns.dispose()
  assert.equal(seen.timers.size, 0)
  assert.equal(seen.cancels, 1)
  assert.equal(seen.speakers.at(-1).cancelled, true)
  const phases = seen.phases.length
  asks[0].handlers.onText(' and warm')
  asks[0].resolve({ text: 'Sunny and warm' })
  await settle()
  assert.equal(seen.turns.at(-1).text, 'Sunny')
  assert.equal(seen.phases.length, phases)
  assert.equal(seen.timers.size, 0)
  assert.equal(turns.mode(), 'deaf')
  turns.onWake('again')
  turns.sendText('again')
  assert.equal(asks.length, 1)
  assert.equal(state.phase, 'speaking')
})

test('mount, unmount and mount again leaves one microphone', async () => {
  const live = new Set()
  let started = 0
  let release
  const start = async () => {
    started++
    if (started === 1) await new Promise((resolve) => { release = resolve })
    const voice = { stop: () => live.delete(voice), live: () => live.has(voice) }
    live.add(voice)
    return voice
  }
  const handlers = { mode: () => 'wake', onWake() {}, onSpeechStart() {}, onPartial() {}, onUtterance() {}, onError() {} }

  // The first app goes away while its microphone is still opening.
  const first = createListening(start, handlers)
  const arming = first.arm()
  assert.equal(first.arm(), arming, 'a second arm reuses the first')
  await settle()
  first.stop()
  release()
  await arming
  assert.equal(live.size, 0, 'a loop that arrives after the app left is stopped on arrival')

  const second = createListening(start, handlers, async () => { throw new Error('no analyser') })
  await second.arm()
  assert.equal(live.size, 1)
  assert.equal(second.live(), true)
  second.stop()
  assert.equal(live.size, 0)
  assert.equal(started, 2)
})

test('the first-gesture wait is removed when the app goes away first', () => {
  const listeners = new Map()
  const target = {
    addEventListener: (type, fn, capture) => listeners.set(`${type}:${capture}`, fn),
    removeEventListener: (type, fn, capture) => { if (listeners.get(`${type}:${capture}`) === fn) listeners.delete(`${type}:${capture}`) },
  }
  let armed = 0
  const remove = onFirstGesture(target, () => armed++)
  assert.equal(listeners.size, 2)
  listeners.get('keydown:true')({ key: 'Escape' })
  assert.equal(armed, 0, 'Escape is not a gesture')
  remove()
  assert.equal(listeners.size, 0)

  onFirstGesture(target, () => armed++)
  listeners.get('pointerup:true')({})
  assert.equal(armed, 1)
  assert.equal(listeners.size, 0, 'armed once, then the listeners are gone')
})
