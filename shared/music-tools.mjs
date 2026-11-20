/**
 * Music: `play_music` to start something, `music` to drive what is playing.
 *
 * Defined once for every model, like the rest of the catalogue. A device that
 * can carry a player supplies `play(op)`; one that cannot is simply not
 * offered these. The player itself is the small panel in the corner of the
 * interface — the point of this is that the music plays inside JARVIS, under
 * his hand and the user's, rather than being handed off to a browser tab he
 * has no further say over.
 *
 * Browser-safe.
 */

import { youtubeTarget, youtubeWatch } from './youtube.mjs'

export const MUSIC_TOOLS = new Set(['play_music', 'music'])

const PLAY_GUIDE = `Three ways to say what to play, in order of how sure they are:

  url       — a YouTube address you have actually seen, in a search result or
              from the user. A playlist address works here too.
  playlist  — a playlist address or id, when you specifically mean a playlist.
  query     — words to look up, for "play Stevie Wonder, As". Use this when you
              do not have an address; it searches and takes the first video.

A playlist the user calls theirs — "my music playlist" — is not something you
can look up: their own playlists are private to their account and this plays
through an embedded player, which only sees public and unlisted ones. Check
your memory for its address first. If it is not there, ask for the link once
and \`remember\` it, and it will be there the next time they ask.

The player stays on screen between turns and keeps playing while you answer
other questions, so there is no need to re-launch what is already playing —
use \`music\` to change it.`

const CONTROL_GUIDE = `The player already on screen. Nothing to pass but what to do:

  play / pause / stop   — stop closes the player; pause keeps the place.
  next / previous       — within a playlist. A single video has neither.
  forward / back        — by \`seconds\`, default thirty. "Skip ahead a minute"
                          is forward with seconds 60.
  restart               — back to the beginning of the track.

Say what you did in a few words. Do not describe the music: they can hear it.`

/**
 * @param {(op: object) => Promise<string>} play  The device's player.
 * @param {{ search?: (query: string, options?: { signal?: AbortSignal }) => Promise<string|null> }} [options]
 *   Resolves words to a YouTube address. Without it, `query` is refused with
 *   a reason rather than silently ignored.
 */
export function musicTools(play, { search } = {}) {
  return [
    {
      name: 'play_music',
      description: 'Play a video, a track or a playlist in the player inside JARVIS.',
      guide: PLAY_GUIDE,
      parameters: {
        type: 'object',
        required: [],
        properties: {
          query: { type: 'string', description: 'Words to search for, when you have no address.' },
          url: { type: 'string', description: 'A YouTube address you have seen.' },
          playlist: { type: 'string', description: 'A playlist address or id.' },
        },
      },
      async run({ query, url, playlist } = {}, { signal } = {}) {
        const target = youtubeTarget(playlist) ?? youtubeTarget(url)
        if (target) return play({ op: 'play', ...target })

        const words = String(query ?? '').trim()
        if (!words) throw new Error('Give a YouTube address or some words to search for.')
        if (!search) throw new Error('No way to search from here — pass a YouTube address.')

        const found = await search(words, { signal })
        const hit = youtubeTarget(found)
        if (!hit) throw new Error(`Nothing on YouTube for "${words}" — try different words, or pass an address.`)
        return play({ op: 'play', ...hit, source: youtubeWatch(hit) })
      },
    },
    {
      name: 'music',
      // Forgiving: a mangled action from a small model becomes an absent one,
      // and the device answers with what it can do rather than throwing.
      forgiving: true,
      description: 'Drive the player: pause, resume, next, previous, forward or back by seconds, stop.',
      guide: CONTROL_GUIDE,
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['play', 'pause', 'stop', 'next', 'previous', 'forward', 'back', 'restart'],
          },
          seconds: { type: 'number', description: 'For forward and back. Default 30.' },
        },
      },
      run: ({ action, seconds } = {}) =>
        play({ op: 'control', action, seconds: Number(seconds) > 0 ? Math.min(3600, Number(seconds)) : undefined }),
    },
  ]
}
