import { useStore } from '../store'
import { youtubeTarget } from '../../shared/youtube.mjs'

/**
 * The player, driven by message.
 *
 * YouTube's embedded player answers postMessage when it is loaded with
 * `enablejsapi=1`, and that is the entire protocol: a JSON envelope naming a
 * function and its arguments. This talks to it directly rather than loading
 * YouTube's own iframe_api script, for two reasons — the script would need
 * www.youtube.com in script-src, which is a whole origin of someone else's
 * JavaScript admitted into the page for a convenience wrapper, and the
 * protocol underneath is six lines.
 *
 * Both directions are pinned to the player's origin: commands are addressed
 * to it rather than to '*', and nothing is read from a message that did not
 * come from it. An iframe is a window on the internet; this one is allowed to
 * say what it is playing and nothing else.
 *
 * The same code serves the PC and the phone. On the PC the op arrives down
 * the socket from the bridge, on the phone the tool calls it in the WebView;
 * by here they are the same thing.
 */

const ORIGIN = 'https://www.youtube-nocookie.com'

/** The frame currently on screen, handed over by the component that owns it. */
let frame: HTMLIFrameElement | null = null
/** Commands asked for before the player was listening. */
let pending: string[] = []
let ready = false

function post(message: Record<string, unknown>): void {
  const body = JSON.stringify(message)
  if (!frame?.contentWindow || !ready) {
    // Three is plenty: these are "skip" and "pause" said while the thing is
    // still loading, and a backlog longer than that is a backlog of mistakes.
    pending = [...pending.slice(-2), body]
    return
  }
  frame.contentWindow.postMessage(body, ORIGIN)
}

const command = (func: string, args: unknown[] = []) => post({ event: 'command', func, args })

/**
 * Seek, and seek again if the track has only just started.
 *
 * A player still working out what it is playing swallows the first seek it is
 * given — "put on X and skip the intro" is one sentence, so the two arrive
 * within a second of each other and the second half of it was being lost.
 * Seeking is to an absolute time, so asking twice is the same as asking once.
 */
function seek(to: number): void {
  const target = Math.max(0, to)
  command('seekTo', [target, true])
  if (position < 2) setTimeout(() => command('seekTo', [target, true]), 800)
}

/**
 * Called by the component when its iframe has loaded.
 *
 * The handshake is what turns the frame from a video into an instrument: until
 * the parent says it is listening, the player reports nothing about itself and
 * there is no way to know the time, the title, or whether it is even playing.
 */
export function attachPlayer(element: HTMLIFrameElement): void {
  frame = element
  ready = true
  post({ event: 'listening', id: 'jarvis', channel: 'widget' })
  for (const body of pending.splice(0)) element.contentWindow?.postMessage(body, ORIGIN)
}

export function detachPlayer(element: HTMLIFrameElement): void {
  if (frame !== element) return
  frame = null
  ready = false
  pending = []
}

/** Seconds into the track, as last reported. Seeking by an offset needs it. */
let position = 0

/**
 * Whoever is waiting to hear whether the thing actually started.
 *
 * A launch has to be able to fail honestly. YouTube accepts any id and then
 * refuses some of them — an upload whose owner disabled embedding answers
 * with error 101 or 150, several seconds after the frame has loaded, and
 * every search for a song turns up a few of those. Without this the tool
 * says "Playing." to a black rectangle, the user says nothing is playing,
 * and the model has no idea which of them is wrong.
 */
let launch: { done: (text: string) => void; fail: (reason: string) => void; timer: number } | null = null

/**
 * Why the last launch came to nothing, when the refusal arrived too late to
 * be the tool's own answer. The player can take a few seconds to decide, and
 * a turn cannot be held open that long — so the next thing asked of the
 * player says what happened instead of pretending it is paused.
 */
let refused: string | null = null

const settle = (outcome: 'done' | 'fail', text: string) => {
  const waiting = launch
  if (!waiting) return
  launch = null
  clearTimeout(waiting.timer)
  waiting[outcome](text)
}

/** Why YouTube refused, in a sentence the model can pass on and act on. */
const REFUSALS: Record<number, string> = {
  2: 'YouTube rejected that address.',
  5: 'That video will not play in an embedded player.',
  100: 'That video is gone — removed or private.',
  101: 'The owner of that video does not allow it to be played outside YouTube.',
  150: 'The owner of that video does not allow it to be played outside YouTube.',
}

/**
 * What the player says about itself.
 *
 * Mounted once for the life of the page rather than with the component: the
 * player comes and goes, and a listener that came and went with it would miss
 * the first state change of every track. Everything is checked for origin and
 * shape before it reaches the store.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.origin !== ORIGIN || typeof event.data !== 'string') return
    let message: { event?: string; info?: Record<string, unknown> }
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message?.event === 'onError') {
      const code = Number(message.info)
      const reason = REFUSALS[code] ?? `The player refused that video (error ${code}).`
      const music = useStore.getState().music
      // Inside a playlist a bad track is a gap, not a stop: step over it and
      // keep the music going, which is what a person would do.
      if (music?.playlist) {
        command('nextVideo')
        settle('done', 'Playing the playlist.')
        return
      }
      refused = reason
      useStore.getState().noteMusic({ title: reason, playing: false })
      settle('fail', reason)
      return
    }

    const info = message?.info
    if (!info || typeof info !== 'object') return

    const patch: Record<string, unknown> = {}
    if (typeof info.currentTime === 'number') patch.position = position = info.currentTime
    if (typeof info.duration === 'number') patch.duration = info.duration
    // 1 playing, 2 paused, 3 buffering, 0 ended. Buffering counts as playing:
    // it is a player that has been asked for sound and is about to make some.
    if (typeof info.playerState === 'number') patch.playing = info.playerState === 1 || info.playerState === 3
    const data = info.videoData as { title?: string } | undefined
    if (data && typeof data.title === 'string' && data.title) patch.title = data.title
    if (Object.keys(patch).length) useStore.getState().noteMusic(patch)
    // Playing, with a name: that is a launch that worked, and the name is
    // worth handing back — it is how the user hears that he found the right
    // track rather than a cover of it.
    if (patch.playing === true || (patch.title && useStore.getState().music?.playing)) {
      const title = useStore.getState().music?.title
      settle('done', title ? `Playing: ${title}.` : 'Playing.')
    }
  })
}

export type MusicOp =
  | { op: 'play'; video?: string; playlist?: string; source?: string }
  | { op: 'control'; action?: string; seconds?: number }

/** The default step for "skip ahead" when no length is given. */
const STEP = 30

/**
 * One operation from the model, applied, with a sentence back for it.
 *
 * The sentence is what the model has to go on: it cannot see the player, so
 * "Playing." has to mean the player really is up. What it must not do is
 * describe the music — asking YouTube for a title takes a second, and an
 * answer that waits for it is an answer that arrives after the sound does.
 */
export async function applyMusicOp(raw: MusicOp): Promise<string> {
  const store = useStore.getState()
  if (raw?.op === 'play') {
    const target = youtubeTarget(raw.playlist ?? raw.video ?? '')
      ?? (raw.video ? { video: raw.video } : null)
    if (!target) throw new Error('That is not a YouTube address.')
    store.playMusic({ ...target, source: raw.source })
    position = 0
    refused = null
    // Wait to be told, but not for long: three seconds covers the frame
    // loading and the first state change on any connection worth playing
    // music over, and past that an optimistic answer beats a stalled turn.
    return new Promise((resolve, reject) => {
      settle('fail', 'replaced by a newer launch')
      launch = {
        done: resolve,
        fail: (reason) => reject(new Error(reason)),
        timer: setTimeout(() => settle('done', target.playlist ? 'Playing the playlist.' : 'Playing.'), 4000) as unknown as number,
      }
    })
  }

  if (raw?.op !== 'control') throw new Error('Unknown player operation.')
  const music = useStore.getState().music
  if (!music) throw new Error('Nothing is playing.')
  // A refusal that landed after the launch had already answered. Say it now,
  // once, so the model can look for the track somewhere else rather than
  // explaining to the user that it is definitely playing.
  if (refused && raw.action !== 'stop') {
    const reason = refused
    refused = null
    throw new Error(`${reason} Nothing is playing — find another version.`)
  }

  const step = raw.seconds && raw.seconds > 0 ? raw.seconds : STEP
  switch (raw.action) {
    case 'play':
      command('playVideo')
      store.noteMusic({ playing: true })
      return 'Playing.'
    case 'pause':
      command('pauseVideo')
      store.noteMusic({ playing: false })
      return 'Paused.'
    case 'stop':
      command('stopVideo')
      store.stopMusic()
      return 'Stopped.'
    case 'next':
      if (!music.playlist) throw new Error('This is one track, not a playlist — there is nothing after it.')
      command('nextVideo')
      return 'Next track.'
    case 'previous':
      if (!music.playlist) throw new Error('This is one track, not a playlist — there is nothing before it.')
      command('previousVideo')
      return 'Previous track.'
    case 'forward':
      seek(position + step)
      return `Forward ${step} seconds.`
    case 'back':
      seek(Math.max(0, position - step))
      return `Back ${step} seconds.`
    case 'restart':
      seek(0)
      return 'From the beginning.'
    default:
      throw new Error('Say what to do: play, pause, stop, next, previous, forward, back or restart.')
  }
}

/** The buttons on the panel drive the same path the model does. */
export const playerControl = (action: string, seconds?: number) =>
  applyMusicOp({ op: 'control', action, seconds }).catch(() => {})
