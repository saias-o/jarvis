/**
 * The microphone's lifetime, for the app.
 *
 * Starting the voice loop is asynchronous — a permission prompt, a native
 * plugin, a model — and the app can go away before it answers. A loop that
 * arrives after that must be stopped on arrival, or it keeps the microphone
 * for a page that no longer listens, and the next mount opens a second one.
 */
import type { Voice, VoiceHandlers } from './voice'

export type Listening = {
  /** Start the loop once; later calls return the same start. */
  arm(): Promise<void>
  /** Stop the loop, now or as soon as it has started. */
  stop(): void
  live(): boolean
}

export function createListening(
  start: (handlers: VoiceHandlers) => Promise<Voice>,
  handlers: VoiceHandlers,
  /** Opened first; a failure costs only what it feeds (the reactor's pulse). */
  analyser?: () => Promise<unknown>,
): Listening {
  let voice: Voice | null = null
  let arming: Promise<void> | null = null
  let stopped = false
  return {
    arm() {
      arming ??= (async () => {
        try {
          await analyser?.()
        } catch {
          console.warn(
            '[jarvis] no microphone stream — the reactor will not pulse with your ' +
              'voice. Speech recognition is unaffected.',
          )
        }
        if (stopped) return
        const started = await start(handlers)
        if (stopped) started.stop()
        else voice = started
      })()
      return arming
    },
    stop() {
      stopped = true
      voice?.stop()
      voice = null
    },
    live: () => Boolean(voice?.live()),
  }
}

/**
 * Run `arm` on the first gesture the user makes for any reason — a tap, a
 * click into the text field, a key. Everything a browser refuses before a
 * gesture (audio, the microphone) starts there. Returns the way to stop
 * waiting, for an app that goes away first.
 *
 * pointerup rather than pointerdown: for a finger, the press is not what a
 * browser counts as the gesture — the release is.
 */
export function onFirstGesture(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, arm: () => void): () => void {
  const remove = () => {
    target.removeEventListener('pointerup', fire, true)
    target.removeEventListener('keydown', fire, true)
  }
  function fire(e: Event) {
    // Escape is the one key a browser does not count as a gesture.
    if ((e as KeyboardEvent).key === 'Escape') return
    remove()
    arm()
  }
  target.addEventListener('pointerup', fire, true)
  target.addEventListener('keydown', fire, true)
  return remove
}
