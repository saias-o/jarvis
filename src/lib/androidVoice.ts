import type { Voice, VoiceHandlers } from './voice'
import { wakePhrase } from '../../shared/wake-phrase.mjs'

type Recognition = { text?: string; final?: boolean; error?: number }

/** The native recogniser, as the JarvisSpeech plugin exposes it. */
export type SpeechEngine = {
  addListener(event: string, callback: (event: Recognition) => void): Promise<{ remove(): Promise<void> }>
  start(options: { lang: string }): Promise<void>
  stop(): Promise<void>
}

/** Nobody spoke, or nothing was understood: a one-shot session ending normally. */
const SILENCE = [6, 7]
/** The engine is still closing the previous session; simply ask again. */
const BUSY = 8
/** A failed session is retried, ever more patiently, for as long as the app runs. */
const RETRY_MS = [1000, 3000, 8000, 15000]

export async function startAndroidVoice(speech: SpeechEngine, lang: string, h: VoiceHandlers): Promise<Voice> {
  let stopped = false
  let listening = false
  let starting = false
  let failures = 0
  let next = 0
  let ended = 0
  const audible = () => !globalThis.document?.hidden && ['wake', 'command'].includes(h.mode())

  const suspend = () => {
    listening = false
    ended++
    next = 0
    void speech.stop()
  }
  // The native plugin cancels recognition on pause. Clear the JS session too,
  // even if Android suspended the WebView before its next polling tick.
  globalThis.document?.addEventListener('visibilitychange', suspend)

  // An engine that is starting up, offline or switching models recovers by
  // itself, so a failure never ends the loop. One lone failure followed by a
  // session that works is not worth alarming anyone; a second one is reported.
  const fail = (message: string) => {
    listening = false
    next = Date.now() + RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]
    if (++failures === 2) h.onError(message)
  }

  const result = await speech.addListener('recognition', (event) => {
    if (stopped) return
    if (event.final) { ended++; listening = false; next = Date.now() + 500 }
    if (event.error) {
      if (SILENCE.includes(event.error)) failures = 0
      else if (event.error !== BUSY) {
        fail([12, 13].includes(event.error)
          ? 'Le moteur vocal Android n’a pas le français. Activez ou téléchargez le français dans les réglages de reconnaissance vocale du téléphone.'
          : `Reconnaissance Android indisponible (${event.error}). Nouvel essai automatique.`)
      }
      return
    }
    failures = 0
    if (!audible()) return
    if (h.mode() === 'wake') {
      // Wait for Android's complete utterance: a partial wake would send an
      // unfinished command or make the greeting speak over the rest of it.
      const wake = event.final && wakePhrase(event.text ?? '')
      if (wake) h.onWake(wake.trailing)
      return
    }
    if (h.mode() !== 'command') return
    if (event.text) h.onPartial(event.text)
    if (event.final && event.text?.trim()) h.onUtterance(event.text.trim())
  })
  const started = await speech.addListener('speechStart', () => {
    if (!stopped && audible() && h.mode() === 'command') h.onSpeechStart()
  })
  const poll = setInterval(() => {
    if (stopped) return
    if (!audible()) {
      if (listening) suspend()
      return
    }
    if (listening || starting || Date.now() < next) return
    starting = true
    const session = ended
    void speech.start({ lang }).then(() => {
      if (stopped || !audible()) void speech.stop()
      else if (session === ended) listening = true
    }).catch((err) => fail(String(err?.message ?? err)))
      .finally(() => { starting = false })
  }, 200)
  return {
    live: () => !stopped && listening,
    stop: () => {
      stopped = true; clearInterval(poll)
      globalThis.document?.removeEventListener('visibilitychange', suspend)
      void speech.stop(); void result.remove(); void started.remove()
    },
  }
}
