// The phone's listening loop: it must survive a recogniser that fails.
//
//   node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tsImport } from 'tsx/esm/api'

const { startAndroidVoice } = await tsImport('../src/lib/androidVoice.ts', import.meta.url)

/** A scripted JarvisSpeech plugin and the handlers the app would pass. */
async function voice(t, { start = async () => {} } = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const listeners = {}
  const seen = { starts: 0, stops: 0, errors: [], partials: [], utterances: [] }
  const speech = {
    addListener: async (event, callback) => { listeners[event] = callback; return { remove: async () => {} } },
    start: async (options) => { seen.starts++; assert.deepEqual(options, { lang: 'fr-FR' }); return start(seen.starts) },
    stop: async () => { seen.stops++ },
  }
  const running = await startAndroidVoice(speech, 'fr-FR', {
    mode: () => 'command', onWake: () => {}, onSpeechStart: () => {},
    onPartial: (text) => seen.partials.push(text),
    onUtterance: (text) => seen.utterances.push(text),
    onError: (message) => seen.errors.push(message),
  })
  /** Let the poll fire and the start() promise settle. */
  const advance = async (ms) => { t.mock.timers.tick(ms); for (let i = 0; i < 4; i++) await Promise.resolve() }
  return { running, seen, advance, emit: (event) => listeners.recognition(event) }
}

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
