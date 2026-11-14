import { JarvisSpeech } from './android'
import { VOICE_LANG } from '../config'
import type { Voice, VoiceHandlers } from './voice'

export async function startAndroidVoice(h: VoiceHandlers): Promise<Voice> {
  let stopped = false
  let listening = false
  let starting = false
  let failed = false
  let next = 0
  const result = await JarvisSpeech.addListener('recognition', (event) => {
    if (stopped) return
    if (event.final) { listening = false; next = Date.now() + 500 }
    if (event.error) {
      // Silence is an ordinary end of a one-shot Android recognition session.
      if (![6, 7, 8].includes(event.error)) {
        failed = true
        h.onError([12, 13].includes(event.error)
          ? 'Le moteur vocal Android n’a pas le français. Activez ou téléchargez le français dans les réglages de reconnaissance vocale du téléphone.'
          : `Reconnaissance Android indisponible (${event.error}).`)
      }
      return
    }
    if (h.mode() !== 'command') return
    if (event.text) h.onPartial(event.text)
    if (event.final && event.text?.trim()) h.onUtterance(event.text.trim())
  })
  const speech = await JarvisSpeech.addListener('speechStart', () => {
    if (!stopped && h.mode() === 'command') h.onSpeechStart()
  })
  const poll = setInterval(() => {
    if (stopped) return
    if (h.mode() !== 'command' || document.hidden) {
      if (listening) { listening = false; void JarvisSpeech.stop() }
      return
    }
    if (listening || starting || failed || Date.now() < next) return
    starting = true
    void JarvisSpeech.start({ lang: VOICE_LANG }).then(() => {
      if (stopped || h.mode() !== 'command') void JarvisSpeech.stop()
      else listening = true
    }).catch((err) => { failed = true; h.onError(String(err.message ?? err)) })
      .finally(() => { starting = false })
  }, 200)
  return {
    live: () => !stopped && !failed,
    stop: () => {
      stopped = true; clearInterval(poll)
      void JarvisSpeech.stop(); void result.remove(); void speech.remove()
    },
  }
}
