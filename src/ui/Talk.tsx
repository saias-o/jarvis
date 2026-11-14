import { useStore } from '../store'
import { IS_FRENCH } from '../config'

/**
 * The talk button — the space bar, for a device that has none.
 *
 * A phone cannot be relied on to hear a wake word: the page only listens while
 * it is on screen, and a pocket is a poor microphone. So on a touch screen
 * there is one thing to press. It wakes him, it cuts him off mid-answer, and
 * pressed while he is already listening it stands him down. Hidden by the
 * stylesheet wherever there is a keyboard and a fine pointer, where the space
 * bar already does this.
 */
export function Talk({ onPress }: { onPress: () => void }) {
  const phase = useStore((s) => s.phase)
  if (phase === 'offline' || phase === 'boot') return null

  const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'
  const live = phase === 'listening' || phase === 'waking'
  const label = busy
    ? IS_FRENCH ? 'Interrompre' : 'Interrupt'
    : live
      ? IS_FRENCH ? 'Arrêter l’écoute' : 'Stop listening'
      : IS_FRENCH ? 'Parler' : 'Talk'

  return (
    <button
      className={`talk${live ? ' talk-live' : ''}${busy ? ' talk-busy' : ''}`}
      onClick={onPress}
      aria-label={label}
      aria-pressed={live}
    >
      {busy ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <rect x="9" y="3.5" width="6" height="11" rx="3" />
          <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
        </svg>
      )}
    </button>
  )
}
