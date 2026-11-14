/**
 * Keep the screen on while JARVIS is up.
 *
 * A phone dims and locks after half a minute without a touch, and a locked
 * page loses its microphone — so a voice assistant that is only ever spoken to
 * would go deaf mid-conversation. The lock is released by the browser whenever
 * the page is hidden, so it is asked for again each time it comes back.
 *
 * Best effort throughout: the API is missing on older browsers and refused in
 * battery saver, and neither is worth a word to the user.
 */

type Sentinel = { release: () => Promise<void> }
type WakeLockApi = { request: (kind: 'screen') => Promise<Sentinel> }

let wanted = false

async function acquire() {
  const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock
  if (!api || !wanted || document.visibilityState !== 'visible') return
  try {
    await api.request('screen')
  } catch {
    /* refused: the screen simply dims as it always did */
  }
}

export function keepScreenOn(): void {
  if (wanted) return
  wanted = true
  document.addEventListener('visibilitychange', () => void acquire())
  void acquire()
}
