import { diskPath } from './diskPath.ts'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const MEDIA_ROUTES = new Set(['/file', '/img', '/media'])

/** Media belongs to the PC's bridge, even when the viewer is a phone. */
export function mediaUrl(raw: string, bridge: string, route: 'img' | 'media' = 'img'): string {
  const src = String(raw ?? '').trim()
  if (!src) return ''
  const base = bridge.replace(/\/$/, '')
  const path = diskPath(src)
  if (path) return `${base}/file?path=${encodeURIComponent(path)}`
  if (!/^https?:\/\//i.test(src)) return src

  let url: URL
  try {
    url = new URL(src)
  } catch {
    return ''
  }
  const target = new URL(base)
  if (url.origin === target.origin) return src

  // A tool may return the PC's local /file URL. On a phone localhost is the
  // phone itself; proxying that URL through /img also fails the SSRF check.
  // Rebase only known bridge media endpoints, keeping their query intact.
  if (
    LOOPBACK.has(url.hostname) &&
    ['8787', '8788', target.port].includes(url.port) &&
    MEDIA_ROUTES.has(url.pathname)
  ) {
    return `${base}${url.pathname}${url.search}`
  }
  return `${base}/${route}?url=${encodeURIComponent(src)}`
}
