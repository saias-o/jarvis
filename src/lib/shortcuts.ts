/**
 * The app's keys. Blades bind their own (E, X, [ and ]) only while one is open.
 */
import { useStore } from '../store'
import { IS_FRENCH } from '../config'
import { cycleVoice } from './tts'
import * as hands from './hands'
import type { Turns } from './turns'

const bare = (e: KeyboardEvent) => !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey

/** Binds the keys to `target`; returns the unbind. */
export function bindShortcuts(target: Window, turns: Turns, powerOn: () => void): () => void {
  const store = useStore.getState

  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return

    // V auditions the next British voice installed on this machine. Which
    // ones exist varies per Mac, so hearing them beats trusting a ranking.
    // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
    if (e.key === 'v' && bare(e)) {
      e.preventDefault()
      const name = cycleVoice()
      store().setVoice(name)
      const label = name.replace(/\(.*?\)/g, '').trim()
      void turns.speak(
        IS_FRENCH
          ? `Voix réglée sur ${label}. À votre service.`
          : `Voice set to ${label}. At your service, sir.`,
      )
      return
    }

    // G puts the camera on and starts tracking hands. Off by default and
    // never implicit: a webcam that turns itself on because an interface
    // thought it might be useful is not a trade anyone agreed to.
    if (e.key === 'g' && bare(e)) {
      e.preventDefault()
      if (store().gestures) {
        hands.disableHands()
        store().setGestures(false)
      } else {
        store().setError(null)
        void hands
          .enableHands()
          .then(() => store().setGestures(true))
          .catch((err: Error) => {
            store().setGestures(false)
            store().setError(
              err?.name === 'NotAllowedError'
                ? 'Camera access denied — gesture control is unavailable.'
                : `Gesture control failed to start: ${err?.message ?? err}`,
            )
          })
      }
      return
    }

    // T speaks a fixed line, bypassing the wake word, the recogniser and the
    // model entirely. When "I can't hear him" is the report, this is the one
    // keypress that separates a broken voice engine from a broken voice loop
    // — and it prints the verdict rather than making you infer it.
    if (e.key === 't' && bare(e)) {
      e.preventDefault()
      void turns
        .speak(
          IS_FRENCH
            ? 'Test audio. Si vous m’entendez, la synthèse vocale fonctionne.'
            : 'Audio test. If you can hear this, speech output is working, sir.',
        )
        .then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
      return
    }

    // Escape stands the whole thing down.
    if (e.key === 'Escape') {
      e.preventDefault()
      if (store().phase !== 'offline') turns.goDormant()
      return
    }

    // Space starts a turn without the wake word. Worth using while filming so
    // a missed wake word doesn't cost a take.
    if (e.code !== 'Space' || e.repeat) return
    e.preventDefault()

    const phase = store().phase
    if (phase === 'offline') powerOn()
    else if (phase === 'boot') {
      /* ignore — the boot sequence owns the phase until it finishes */
    } else if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') turns.interrupt()
    else turns.onWake('')
  }

  target.addEventListener('keydown', onKey)
  return () => target.removeEventListener('keydown', onKey)
}
