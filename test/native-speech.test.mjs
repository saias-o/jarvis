import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tsImport } from 'tsx/esm/api'

const { createNativeSpeech, nativeSpeechChunks } = await tsImport('../src/lib/nativeSpeech.ts', import.meta.url)

function engine(t, { autoStart = true, failSpeak = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const utterances = []
  const errors = []
  const calls = { pause: 0, cancel: 0, resume: 0 }
  const synth = {
    speak(utterance) {
      utterances.push(utterance)
      if (failSpeak) throw new Error('engine unavailable')
      if (autoStart) utterance.onstart?.()
    },
    // Reproduce Android: pause interrupts the current utterance permanently.
    pause() {
      calls.pause++
      utterances.at(-1)?.onerror?.({ error: 'interrupted' })
    },
    cancel() { calls.cancel++ },
    resume() { calls.resume++ },
  }
  const speaker = createNativeSpeech({
    synth, voice: () => null, lang: 'fr-FR',
    createUtterance: (text) => ({ text, onstart: null, onend: null, onerror: null }),
    onError: (code) => errors.push(code),
  })
  return { speaker, utterances, calls, errors }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test('Android speech continues beyond five seconds without a pause or cancellation', async (t) => {
  const { speaker, utterances, calls } = engine(t)
  let ended = false
  const finished = speaker.speak('Cette phrase doit être lue entièrement sans être coupée au milieu.').then((result) => { ended = true; return result })
  t.mock.timers.tick(6500)
  assert.equal(calls.pause, 0)
  assert.equal(calls.cancel, 0)
  assert.equal(ended, false)
  utterances[0].onend()
  assert.equal(await finished, true)
})

test('a long answer is spoken completely, in order, one short chunk at a time', async (t) => {
  const { speaker, utterances, calls } = engine(t)
  const answer = 'Voici une réponse détaillée avec des accents français et plusieurs informations à conserver dans leur ordre. '.repeat(10).trim()
  const chunks = nativeSpeechChunks(answer)
  let ended = false
  const finished = speaker.speak(answer).then((result) => { ended = true; return result })
  assert.ok(chunks.length > 3)
  assert.equal(utterances.length, 1)
  for (let i = 0; i < chunks.length; i++) {
    assert.equal(ended, false)
    assert.equal(utterances.length, i + 1)
    assert.equal(utterances[i].text, chunks[i])
    assert.ok(chunks[i].length <= 140)
    assert.ok(chunks[i].split(' ').length <= 20)
    utterances[i].onend()
    await flush()
  }
  assert.equal(await finished, true)
  assert.equal(utterances.map((u) => u.text).join(' '), answer)
  assert.equal(calls.pause, 0)
})

test('deliberate interruption settles playback even when the browser sends no terminal event', async (t) => {
  const { speaker, utterances, calls, errors } = engine(t)
  const finished = speaker.speak('Une réponse avec plusieurs segments à interrompre proprement. '.repeat(8))
  speaker.cancel()
  assert.equal(await finished, false)
  t.mock.timers.tick(10000)
  assert.equal(utterances.length, 1)
  assert.equal(calls.cancel, 1)
  assert.deepEqual(errors, [])
  assert.equal(utterances[0].onend, null)
  assert.equal(utterances[0].onerror, null)
})

test('a slow mobile voice can start without being cancelled after 700ms', async (t) => {
  const { speaker, utterances, calls } = engine(t, { autoStart: false })
  const finished = speaker.speak('Initialisation de la voix sur mobile.')
  t.mock.timers.tick(2200)
  assert.equal(calls.cancel, 0)
  assert.equal(utterances.length, 1)
  utterances[0].onstart()
  t.mock.timers.tick(6500)
  assert.equal(calls.cancel, 0)
  utterances[0].onend()
  assert.equal(await finished, true)
})

test('a stale cancellation event cannot end a fresh retry', async (t) => {
  const { speaker, utterances, errors, calls } = engine(t, { autoStart: false })
  const finished = speaker.speak('Réponse à lire après une initialisation bloquée.')
  const staleError = utterances[0].onerror
  t.mock.timers.tick(3000)
  assert.equal(calls.cancel, 1)
  assert.equal(utterances.length, 2)
  assert.notEqual(utterances[0], utterances[1])
  staleError({ error: 'canceled' })
  utterances[1].onstart()
  utterances[1].onend()
  assert.equal(await finished, true)
  assert.deepEqual(errors, [])
})

test('an engine error after start is a failure, not a completed sentence', async (t) => {
  const { speaker, utterances, errors } = engine(t)
  const finished = speaker.speak('La première phrase ne doit pas masquer une erreur du moteur.')
  utterances[0].onerror({ error: 'interrupted' })
  assert.equal(await finished, false)
  assert.deepEqual(errors, ['interrupted'])
})

test('an unresponsive engine retries once and releases the queue', async (t) => {
  const { speaker, utterances, errors } = engine(t, { autoStart: false })
  const finished = speaker.speak('Test du moteur bloqué.')
  t.mock.timers.tick(3000)
  t.mock.timers.tick(3000)
  assert.equal(await finished, false)
  assert.equal(utterances.length, 2)
  assert.deepEqual(errors, ['no-start'])
})

test('synchronous speech failures release timers and report the failure', async (t) => {
  const { speaker, utterances, errors } = engine(t, { failSpeak: true })
  assert.equal(await speaker.speak('Test du moteur indisponible.'), false)
  t.mock.timers.tick(10000)
  assert.equal(utterances.length, 1)
  assert.deepEqual(errors, ['synthesis-failed'])
})
