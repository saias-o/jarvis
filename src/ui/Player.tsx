import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'
import { attachPlayer, detachPlayer, playerControl } from '../lib/player'
import { youtubeEmbed } from '../../shared/youtube.mjs'
import { ViewerIcon } from './ViewerIcon'

/**
 * The player, in the corner.
 *
 * Small on purpose. It is not the thing being looked at — the reactor is, and
 * whatever blade is open is — but it has to be visible, because a player you
 * cannot see is a tab playing music somewhere with no way to stop it. So:
 * enough frame to see what is playing and to put a hand on it, and no more.
 *
 * Dressed as an instrument rather than as a media widget: bracketed corners,
 * a rule under the head, a transport in hairline squares, and a level line
 * that fills as the track runs. Nothing here is rounded, because nothing else
 * in this interface is.
 *
 * It lives outside the blade stack and outside a turn. Blades clear when the
 * user speaks again; music does not stop because a question was asked.
 */

const clock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function Player() {
  const music = useStore((s) => s.music)
  const frame = useRef<HTMLIFrameElement>(null)

  // The embed is keyed on what is playing, so React builds a new frame rather
  // than reusing one pointed at the previous track — a src swap on a live
  // player leaves its old state behind and the handshake never happens again.
  const key = music ? `${music.playlist ?? ''}:${music.video ?? ''}` : ''
  const src = music ? youtubeEmbed({ video: music.video, playlist: music.playlist }, location.origin) : null
  const through = music && music.duration > 0 ? Math.min(1, music.position / music.duration) : 0

  useEffect(() => {
    const element = frame.current
    if (!element) return
    // Registered now as well as on load. A frame that is already loaded fires
    // no load event, and one is reused whenever the same track comes back —
    // the exit animation keeps the node alive long enough for React to hand
    // it to the next player. Without this, every command after that went into
    // a queue nothing would ever flush. The handshake costs nothing to repeat:
    // the player answers "already initialised" and carries on.
    const attach = () => attachPlayer(element)
    attach()
    element.addEventListener('load', attach)
    return () => {
      element.removeEventListener('load', attach)
      detachPlayer(element)
    }
  }, [key])

  return (
    <AnimatePresence>
      {music && src && (
        <motion.aside
          className={`player${music.playing ? ' player-live' : ''}`}
          initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        >
          {/* The four brackets the rest of the frame is cornered with. */}
          <span className="player-corner player-tl" />
          <span className="player-corner player-tr" />
          <span className="player-corner player-bl" />
          <span className="player-corner player-br" />

          <div className="player-head">
            <span className="player-pip" />
            <span className="player-kind">{music.playlist ? 'PLAYLIST' : 'AUDIO FEED'}</span>
            <button className="player-btn player-quit" onClick={() => playerControl('stop')} aria-label="Stop">
              <ViewerIcon name="close" />
            </button>
          </div>

          <div className="player-screen">
            <iframe
              key={key}
              ref={frame}
              className="player-frame"
              src={src}
              // The same grant the blade viewer's embed has: a player needs
              // its scripts and its own origin, and is given nothing that
              // reaches the room the user is sitting in.
              sandbox="allow-scripts allow-same-origin allow-presentation"
              allow="autoplay; encrypted-media; picture-in-picture"
              // YouTube refuses to play for a site it cannot name, and says
              // so as "Error 153". This sends the origin, never the path.
              referrerPolicy="strict-origin-when-cross-origin"
              title={music.title || 'Player'}
            />
          </div>

          {/* How far through, as a line rather than a number you have to read.
              Transform, so it rides the compositor over a live scene. */}
          <div className="player-rail">
            <div className="player-fill" style={{ transform: `scaleX(${through})` }} />
          </div>

          <div className="player-body">
            <div className="player-title" title={music.title}>
              {music.title || (music.playlist ? 'LOADING PLAYLIST' : 'LOADING')}
            </div>
            <div className="player-foot">
              <div className="player-transport">
                {/* Previous and next belong to a playlist; a single track has
                    neither, so they go rather than sit there dead. */}
                {music.playlist && (
                  <button className="player-btn" onClick={() => playerControl('previous')} aria-label="Previous">
                    <ViewerIcon name="previous" />
                  </button>
                )}
                <button
                  className="player-btn player-main"
                  onClick={() => playerControl(music.playing ? 'pause' : 'play')}
                  aria-label={music.playing ? 'Pause' : 'Play'}
                >
                  <ViewerIcon name={music.playing ? 'pause' : 'play'} />
                </button>
                {music.playlist && (
                  <button className="player-btn" onClick={() => playerControl('next')} aria-label="Next">
                    <ViewerIcon name="next" />
                  </button>
                )}
              </div>
              <div className="player-time">
                {clock(music.position)}
                <span className="player-dim"> / {clock(music.duration)}</span>
              </div>
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
