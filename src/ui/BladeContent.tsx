import { memo, useEffect, useRef, useState } from 'react'
import type { Blade } from '../store'
import { BRIDGE_HTTP_URL } from '../config'
import { mediaUrl } from '../lib/mediaUrl'
import * as camera from '../lib/camera'
import { ImageViewer } from './ImageViewer'
import { MarkupView } from './MarkupView'

/**
 * What a blade shows, whatever holds it: the desktop stack (Blades.tsx) and
 * the phone's single sheet (MobileBlades.tsx) both render this. Where a
 * source is fetched from and how it is sandboxed is decided here; moving,
 * focusing and closing a blade is the holder's business.
 */

/* ------------------------------------------------------------------ sources */

/** Route a source through the bridge, which is the only origin that can
 *  actually fetch it — and the only one the page CSP will load from. */
function viaBridge(raw: string, route: 'img' | 'media'): string {
  return mediaUrl(raw, BRIDGE_HTTP_URL, route)
}

/**
 * Where a PDF blade points. A Google Drive file goes to Drive's own viewer,
 * which reads it with the user's Google sign-in in this browser — nothing is
 * downloaded through the agent. Anything else on the web is fetched by the
 * bridge and shown by Chrome's built-in PDF viewer.
 */
function pdfUrl(raw: string): string | null {
  const src = String(raw ?? '').trim()
  // A bare Drive file id, as the search results give it.
  if (/^[\w-]{20,}$/.test(src)) return `https://drive.google.com/file/d/${src}/preview`
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const id =
      /\/d\/([\w-]{20,})/.exec(url.pathname)?.[1] ?? url.searchParams.get('id') ?? ''
    return /^[\w-]{20,}$/.test(id) ? `https://drive.google.com/file/d/${id}/preview` : null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return `${BRIDGE_HTTP_URL}/pdf?url=${encodeURIComponent(url.href)}`
}

/** A whole document, rendered by the bridge so it can be framed at all. */
const pageUrl = (url: string, mode: 'reader' | 'live') =>
  `${BRIDGE_HTTP_URL}/page?mode=${mode}&url=${encodeURIComponent(url)}`

/**
 * The three embed hosts, and only these.
 *
 * Same closed list as the panel sanitiser, for the same reason: YouTube and
 * Vimeo will not hand over the media file, so an iframe is the only way to play
 * a result inline, and the trade for that is that the host list does not grow.
 */
function embedUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '')
  const id = (s: string) => (/^[\w-]{6,20}$/.test(s) ? s : null)

  if (host === 'youtube.com' && url.pathname === '/watch') {
    const v = id(url.searchParams.get('v') ?? '')
    return v && `https://www.youtube-nocookie.com/embed/${v}`
  }
  if (host === 'youtu.be') {
    const v = id(url.pathname.slice(1))
    return v && `https://www.youtube-nocookie.com/embed/${v}`
  }
  if (host === 'youtube-nocookie.com' && /^\/embed\/[\w-]+/.test(url.pathname)) return url.href
  if (host === 'vimeo.com') {
    const v = url.pathname.split('/').filter(Boolean)[0] ?? ''
    return /^\d+$/.test(v) ? `https://player.vimeo.com/video/${v}` : null
  }
  if (host === 'player.vimeo.com' && /^\/video\/\d+/.test(url.pathname)) return url.href
  return null
}

/* --------------------------------------------------------------------- body */

/**
 * What goes inside a blade.
 *
 * Every iframe is sandboxed. `allow-same-origin` is deliberately absent from
 * the proxied-page case: that document is served from the bridge's own origin —
 * the one origin permitted to open the agent socket — so granting it
 * same-origin would let a page JARVIS found on the web reach that socket. It
 * does not need it. It is being read, not run.
 */
/**
 * The live camera, on screen.
 *
 * Holding the camera for as long as the blade is open does two jobs. It shows
 * the user what JARVIS can see, which is the honest way to run a camera; and it
 * starts the rolling buffer, which is the only reason "what did I just do" can
 * ever be answered — a question that cannot be satisfied by starting to record
 * at the moment it is asked.
 *
 * Mirrored here and only here. A person expects their own image to behave like
 * a reflection, so the preview is flipped for them; the frames handed to the
 * model are not, because a label held up to the lens has to arrive the right
 * way round.
 */
const CameraView = memo(function CameraView() {
  const el = useRef<HTMLVideoElement>(null)
  const [failed, failed_] = useState<string | null>(null)

  useEffect(() => {
    let held = false
    let gone = false
    void camera
      .holdCamera()
      .then((source) => {
        if (gone) {
          camera.releaseCamera()
          return
        }
        held = true
        camera.startBuffer()
        if (el.current && source.srcObject) el.current.srcObject = source.srcObject
      })
      .catch((err: DOMException) =>
        failed_(
          err?.name === 'NotAllowedError'
            ? 'Camera access is not permitted.'
            : `The camera could not be opened: ${err?.message ?? err}`,
        ),
      )
    return () => {
      gone = true
      if (held) camera.releaseCamera()
    }
  }, [])

  if (failed) return <p className="bl-note">{failed}</p>
  return <video ref={el} className="bl-camera" autoPlay playsInline muted />
})

export const Body = memo(function Body({ blade, previous, next }: { blade: Blade; previous?: () => void; next?: () => void }) {
  if (blade.kind === 'camera') return <CameraView />

  if (blade.kind === 'article' && blade.url) {
    return (
      <iframe
        className="bl-frame"
        src={pageUrl(blade.url, blade.mode ?? 'reader')}
        // allow-scripts WITHOUT allow-same-origin. That combination is the
        // point: the page runs in an opaque origin, so the one script the
        // bridge injects can move the document's own scroll position and can
        // reach nothing of ours — not this origin, not the agent socket. Adding
        // allow-same-origin would hand a page found on the web the keys.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={blade.title}
      />
    )
  }

  if (blade.kind === 'embed' && blade.url) {
    const embed = embedUrl(blade.url)
    if (!embed) return <p className="bl-note">That video link could not be played.</p>
    return (
      <iframe
        className="bl-frame"
        src={embed}
        // A player genuinely needs scripts and its own origin. Nothing that
        // reaches the room the user is sitting in is granted.
        sandbox="allow-scripts allow-same-origin allow-presentation"
        allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"
        // Not no-referrer: YouTube and Vimeo refuse to play without knowing
        // which site embeds them, and YouTube says so as "Error 153". This
        // sends the origin alone (http://localhost:5173), never the path.
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
        title={blade.title}
      />
    )
  }

  if (blade.kind === 'pdf' && blade.url) {
    const src = pdfUrl(blade.url)
    if (!src) return <p className="bl-note">That document could not be opened.</p>
    const drive = src.startsWith('https://drive.google.com/')
    return (
      <iframe
        className="bl-frame"
        src={src}
        // Drive's viewer needs its own origin to see the user's sign-in.
        // Chrome's PDF viewer refuses to run in any sandboxed frame at all,
        // and what the bridge serves there is a PDF, never a page of script.
        {...(drive ? { sandbox: 'allow-scripts allow-same-origin allow-popups' } : {})}
        referrerPolicy="no-referrer"
        title={blade.title}
      />
    )
  }

  if (blade.kind === 'video' && blade.url) {
    return (
      <video
        className="bl-video"
        src={viaBridge(blade.url, 'media')}
        controls
        playsInline
        preload="metadata"
      />
    )
  }

  if (blade.kind === 'image' && blade.url) {
    return <ImageViewer key={blade.url} sources={[blade.url]} title={blade.title} previous={previous} next={next} traceContext={blade.trace} />
  }

  if (blade.kind === 'gallery') {
    return <ImageViewer sources={blade.images ?? []} title={blade.title} traceContext={blade.trace} />
  }

  if (blade.kind === 'markup' && blade.html) {
    return <MarkupView key={blade.html} html={blade.html} title={blade.title} />
  }

  return <p className="bl-note">Nothing to show.</p>
})
