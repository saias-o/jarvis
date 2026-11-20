/**
 * What a YouTube address points at: one video, or a playlist.
 *
 * One implementation, because three places need the same answer and must not
 * disagree about it — the tool that accepts what the model asked for, the
 * player that builds the embed, and the blade viewer that already had its own
 * copy of half of this.
 *
 * Ids are matched, never trusted as paths: a video id is eleven characters of
 * the URL alphabet and a playlist id is up to a hundred, and anything that
 * does not look like one is refused rather than interpolated into a URL.
 *
 * Browser-safe.
 */

const VIDEO = /^[\w-]{11}$/
const PLAYLIST = /^[\w-]{2,100}$/

/** The id in `raw`, or null — accepts a bare id as well as a full address. */
export function youtubeTarget(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null

  // A bare id, which is what a model hands over when it already knows one.
  if (VIDEO.test(text)) return { video: text }
  if (/^(PL|OL|RD|UU|LL|FL)[\w-]+$/.test(text) && PLAYLIST.test(text)) return { playlist: text }

  let url
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '')
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com' && host !== 'youtu.be') return null

  const list = url.searchParams.get('list')
  const video = host === 'youtu.be'
    ? url.pathname.slice(1)
    : url.pathname === '/watch'
      ? url.searchParams.get('v') ?? ''
      : /^\/(embed|shorts|v)\/([\w-]+)/.exec(url.pathname)?.[2] ?? ''

  // A watch link inside a playlist carries both. The playlist is the better
  // answer: asked for a playlist, play the playlist, from that track.
  if (list && PLAYLIST.test(list) && list !== 'WL' && list !== 'LL') {
    return VIDEO.test(video) ? { playlist: list, video } : { playlist: list }
  }
  if (url.pathname === '/playlist') return null
  return VIDEO.test(video) ? { video } : null
}

/**
 * The embed address for a target, with the API switched on.
 *
 * `enablejsapi` is what makes the frame answer postMessage, which is the whole
 * difference between a video on screen and a player this assistant can be
 * asked to skip, pause or wind forward a minute. `origin` is required with it:
 * YouTube refuses the channel otherwise.
 *
 * -nocookie for the same reason the blade viewer uses it: nothing here needs
 * to follow the person around afterwards.
 */
export function youtubeEmbed(target, origin) {
  if (!target) return null
  const options = new URLSearchParams({
    enablejsapi: '1',
    origin,
    autoplay: '1',
    playsinline: '1',
    rel: '0',
    // Its own controls as well as ours: the small ones in the corner of the
    // interface are for the hands, the model drives the same player by message.
    controls: '1',
  })
  if (target.playlist) {
    options.set('list', target.playlist)
    options.set('listType', 'playlist')
    // A playlist opened at a track starts there and keeps the rest behind it.
    const path = target.video ? `/embed/${target.video}` : '/embed/videoseries'
    return `https://www.youtube-nocookie.com${path}?${options}`
  }
  return `https://www.youtube-nocookie.com/embed/${target.video}?${options}`
}

/** The watch address, for saying where something came from. */
export const youtubeWatch = (target) =>
  !target ? null
    : target.playlist
      ? `https://www.youtube.com/playlist?list=${target.playlist}`
      : `https://www.youtube.com/watch?v=${target.video}`
