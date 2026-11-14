// The phone's listening loop: it must survive a recogniser that fails.
//
//   node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tsImport } from 'tsx/esm/api'
import { wakePhrase, withoutVocative } from '../shared/wake-phrase.mjs'

const { startAndroidVoice } = await tsImport('../src/lib/androidVoice.ts', import.meta.url)

/** A scripted JarvisSpeech plugin and the handlers the app would pass. */
async function voice(t, { start = async () => {}, mode = 'command' } = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const listeners = {}
  const seen = { starts: 0, stops: 0, errors: [], partials: [], utterances: [], wakes: [] }
  const speech = {
    addListener: async (event, callback) => { listeners[event] = callback; return { remove: async () => {} } },
    start: async (options) => { seen.starts++; assert.deepEqual(options, { lang: 'fr-FR' }); return start(seen.starts) },
    stop: async () => { seen.stops++ },
  }
  const running = await startAndroidVoice(speech, 'fr-FR', {
    mode: () => mode,
    onWake: (text) => { seen.wakes.push(text); mode = text ? 'guard' : 'command' },
    onSpeechStart: () => {},
    onPartial: (text) => seen.partials.push(text),
    onUtterance: (text) => seen.utterances.push(text),
    onError: (message) => seen.errors.push(message),
  })
  /** Let the poll fire and the start() promise settle. */
  const advance = async (ms) => { t.mock.timers.tick(ms); for (let i = 0; i < 4; i++) await Promise.resolve() }
  return { running, seen, advance, emit: (event) => listeners.recognition(event), setMode: (value) => { mode = value } }
}

test('Android listens in standby, wakes only on its name and keeps the command in the same breath', async (t) => {
  const { running, seen, advance, emit } = await voice(t, { mode: 'wake' })
  await advance(200)
  assert.equal(seen.starts, 1, 'no microphone button is needed')
  emit({ text: 'bonjour tout le monde', final: true })
  assert.deepEqual(seen.wakes, [])
  assert.deepEqual(seen.utterances, [])
  await advance(800)
  emit({ text: 'Hey Jarvis, liste', final: false })
  assert.deepEqual(seen.wakes, [], 'wait for the whole sentence')
  emit({ text: 'Hey Jarvis, liste les fichiers', final: true })
  assert.deepEqual(seen.wakes, ['liste les fichiers'])
  assert.deepEqual(seen.utterances, [], 'the command is delivered just once, through onWake')
  await advance(800)
  assert.equal(seen.starts, 2, 'do not transcribe the answer being spoken')
  running.stop()
})

test('a bare wake phrase opens the next Android command session and standby can wake again', async (t) => {
  const { running, seen, advance, emit, setMode } = await voice(t, { mode: 'wake' })
  await advance(200)
  emit({ text: 'Hé Djarvis !', final: true })
  assert.deepEqual(seen.wakes, [''])
  await advance(800)
  emit({ text: 'Quel temps fait-il ?', final: true })
  assert.deepEqual(seen.utterances, ['Quel temps fait-il ?'])
  setMode('wake')
  await advance(800)
  emit({ text: 'Jarvis', final: true })
  assert.deepEqual(seen.wakes, ['', ''])
  running.stop()
})

test('Android pauses while hidden and restarts recognition on return', async (t) => {
  const previous = globalThis.document
  const document = new EventTarget()
  document.hidden = false
  globalThis.document = document
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous })
  const { running, seen, advance, emit } = await voice(t, { mode: 'wake' })
  await advance(200)
  document.hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(seen.stops, 1)
  emit({ text: 'Hey Jarvis', final: true })
  assert.deepEqual(seen.wakes, [], 'a late native callback cannot wake a hidden app')
  await advance(1000)
  assert.equal(seen.starts, 1)
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await advance(200)
  assert.equal(seen.starts, 2)
  emit({ text: 'Hey Jarvis', final: true })
  assert.deepEqual(seen.wakes, [''])
  running.stop()
})

test('a native final arriving before start resolves does not leave Android stuck listening', async (t) => {
  let started
  const { running, seen, advance, emit } = await voice(t, { start: () => new Promise((resolve) => { started = resolve }) })
  await advance(200)
  emit({ error: 7, final: true })
  started()
  await advance(800)
  await advance(200)
  assert.equal(seen.starts, 2)
  started()
  running.stop()
})

test('phone, browser and command cleanup share the same French and English wake phrases', () => {
  for (const text of ['Hey Jarvis', 'Jarvis', 'Hé Djarvis !', 'eh jarvi', 'okay Jervis']) {
    assert.deepEqual(wakePhrase(text), { trailing: '' }, text)
    assert.equal(withoutVocative(text), '', text)
  }
  assert.deepEqual(wakePhrase('Hey Jarvis, liste mes documents.'), { trailing: 'liste mes documents.' })
  assert.equal(withoutVocative('Hé Djarvis, liste mes documents.'), 'liste mes documents.')
  for (const text of ['bonjour', 'jarvison', "Jarvis's job"]) assert.equal(wakePhrase(text), null, text)
})

test('a failed recognition session is retried instead of ending voice for good', async (t) => {
  const { running, seen, advance, emit } = await voice(t)
  await advance(200)
  assert.equal(seen.starts, 1)

  // The engine gives up (the on-device model failed to load, the network dropped…).
  emit({ error: 5, final: true })
  assert.deepEqual(seen.errors, [], 'one lone failure is not reported')
  await advance(800)
  assert.equal(seen.starts, 1, 'not hammered straight away')
  await advance(400)
  assert.equal(seen.starts, 2)

  emit({ error: 5, final: true })
  assert.deepEqual(seen.errors, ['Reconnaissance Android indisponible (5). Nouvel essai automatique.'])
  await advance(3200)
  assert.equal(seen.starts, 3)
  assert.equal(running.live(), true)

  // It works again: the transcript goes through and the next failure starts a fresh count.
  emit({ text: 'bonjour', final: false })
  emit({ text: 'bonjour Jarvis', final: true })
  assert.deepEqual(seen.partials, ['bonjour', 'bonjour Jarvis'])
  assert.deepEqual(seen.utterances, ['bonjour Jarvis'])
  await advance(800)
  assert.equal(seen.starts, 4)
  emit({ error: 2, final: true })
  assert.equal(seen.errors.length, 1)
  running.stop()
})

test('silence restarts listening at once and is never an error', async (t) => {
  const { running, seen, advance, emit } = await voice(t)
  await advance(200)
  for (const error of [6, 7, 8]) {
    emit({ error, final: true })
    await advance(800)
  }
  assert.equal(seen.starts, 4)
  assert.deepEqual(seen.errors, [])
  running.stop()
})

test('a recogniser that cannot start is retried too, and named after the second refusal', async (t) => {
  const { running, seen, advance } = await voice(t, {
    start: async (attempt) => { if (attempt <= 2) throw new Error('Microphone access denied') },
  })
  await advance(200)
  assert.deepEqual(seen.errors, [])
  await advance(1200)
  assert.deepEqual(seen.errors, ['Microphone access denied'])
  await advance(3200)
  assert.equal(seen.starts, 3)
  await advance(15000)
  assert.equal(seen.starts, 3, 'the third session is running; nothing else is started')
  running.stop()
})

test('a missing French model is explained in plain words', async (t) => {
  const { running, seen, advance, emit } = await voice(t)
  await advance(200)
  emit({ error: 13, final: true })
  await advance(1200)
  emit({ error: 13, final: true })
  assert.match(seen.errors[0], /n’a pas le français/)
  running.stop()
})
