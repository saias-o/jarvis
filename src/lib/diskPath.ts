/**
 * Is this a file on the machine JARVIS runs on?
 *
 * Everything he makes or captures — a screenshot, a render, a download — lands
 * on disk as an absolute path, and a page cannot load one: it has to be handed
 * to the bridge's /file endpoint instead. So every surface that shows an image
 * asks this first, and there is one answer rather than three that drift.
 *
 * It used to be three copies of a single pattern that knew only the roots of a
 * Mac or a Linux box. On Windows that recognised nothing: `C:\Users\…\shot.png`
 * went to the browser as it was, the browser read `c:` as a URL scheme it had
 * never heard of, and a blade came up with its title bar and no picture.
 *
 * Returns the path as the bridge wants it, or null for anything that is not a
 * disk path — a web address, a data: URI, or one of the app's own assets, which
 * also begin with a slash and are the reason the POSIX half names its roots
 * rather than accepting any leading slash.
 */

const POSIX_ROOT =
  /^\/(Users|home|root|Volumes|Applications|System|Library|private|tmp|var|opt|mnt|media|srv|data)\//

/** A drive letter, with either kind of slash: `C:\Users\…`, `D:/renders/…`. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/

/** What DOMPurify may leave standing for the rewriter to pick up afterwards. */
export const DISK_PATH_SOURCE = String.raw`[A-Za-z]:[\\/]`

export function diskPath(raw: string | null | undefined): string | null {
  let path = String(raw ?? '').trim()
  const fileUrl = /^file:/i.test(path)
  if (fileUrl) {
    try {
      const url = new URL(path)
      // A file on a different host is not a local screenshot.
      if (url.hostname && url.hostname !== 'localhost') return null
      path = url.pathname
    } catch {
      return null
    }
    // A file URL is percent-encoded; a bare path is not, and may hold a %.
    try {
      path = decodeURIComponent(path)
    } catch {
      /* not valid encoding: take it literally */
    }
  }
  // File URLs and some capture tools put a slash before the Windows drive.
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1)
  return POSIX_ROOT.test(path) || WINDOWS_DRIVE.test(path) || (fileUrl && path.startsWith('/'))
    ? path
    : null
}
