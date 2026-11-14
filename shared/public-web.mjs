/**
 * The gate between a model-chosen address and the network: public web only.
 *
 * Browser-safe, so the PC bridge and the phone judge an address by the same
 * rules. Both sit on a home network and a tailnet, and both fetch addresses a
 * model picked while reading the open web.
 */

/**
 * Hostnames refused before a packet moves.
 *
 * `.local` is mDNS — every printer, NAS and Home Assistant box on the network
 * answers to it — and `.internal` / `.home.arpa` / `.lan` are the same idea by
 * convention. `.ts.net` is the tailnet, where the PC bridge itself lives. These
 * never name anything on the public web, so a request for one is either
 * confused or hostile.
 */
const BLOCKED_HOSTNAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|ts\.net)$/i

/**
 * Is this address one that must not be connected to?
 *
 * The list is the usual suspects plus the ones people forget: 169.254.169.254
 * is the cloud metadata endpoint, 100.64/10 is carrier-grade NAT (and Tailscale
 * lives there), 0.0.0.0/8 and the v4-mapped v6 forms are the classic ways of
 * writing "localhost" that a naive string check waves straight through.
 */
export function blockedAddress(ip) {
  let addr = String(ip ?? '').toLowerCase().split('%')[0]
  // ::ffff:127.0.0.1 is loopback wearing a hat. Unwrap before judging.
  //
  // Worth knowing where this can and cannot fire. WHATWG URL parsing serialises
  // an IPv4-mapped literal into hex — new URL('http://[::ffff:127.0.0.1]/')
  // gives a hostname of [::ffff:7f00:1] — so a dotted-quad form never survives
  // to reach this branch from a parsed URL. It is still load-bearing for the
  // other caller: DNS answers arrive as strings in exactly this shape.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr)
  if (mapped) addr = mapped[1]

  if (addr.includes('.')) {
    const parts = addr.split('.').map(Number)
    if (parts.length !== 4) return true
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
    const [a, b] = parts
    if (a === 0) return true // 0.0.0.0/8 — "this network", routes to localhost
    if (a === 10) return true // 10/8
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local AND cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
    if (a === 192 && b === 168) return true // 192.168/16
    if (a === 192 && b === 0) return true // 192.0.0/24 protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT / tailnets
    if (a === 198 && (b === 18 || b === 19)) return true // benchmarking range
    if (a >= 224) return true // multicast, reserved, broadcast
    return false
  }

  // The hex forms the parser actually produces, including the mapped range that
  // the dotted-quad unwrap above can never see.
  if (addr === '::' || addr === '::1') return true
  if (/^::ffff:/.test(addr)) {
    const hex = addr.slice(7).split(':')
    if (hex.length === 2) {
      const high = parseInt(hex[0], 16)
      const low = parseInt(hex[1], 16)
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return blockedAddress(
          [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'),
        )
      }
    }
    return true
  }
  if (/^f[cd]/.test(addr)) return true // fc00::/7 unique local
  if (/^fe[89ab]/.test(addr)) return true // fe80::/10 link-local
  if (/^ff/.test(addr)) return true // multicast
  return false
}

/** An error carrying the HTTP status a proxy should answer with. */
export function proxyError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * Only absolute http(s) URLs, and only ones whose host isn't obviously local.
 * Returns a URL or throws a proxyError, so callers can treat parse failure and
 * policy failure the same way.
 */
export function vetTarget(raw) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw proxyError(400, 'absolute http(s) url required')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw proxyError(400, 'absolute http(s) url required')
  }
  if (!url.hostname) throw proxyError(400, 'absolute http(s) url required')
  if (BLOCKED_HOSTNAME.test(url.hostname)) throw proxyError(403, 'blocked host: not on the public web')
  // An IP literal never reaches DNS in any meaningful sense, so judge it here —
  // this is what turns http://127.0.0.1:8787/health into a refusal before a
  // socket is opened rather than after. The parser has already normalised every
  // spelling of an IPv4 address to a dotted quad and bracketed every IPv6 one.
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  const isLiteral = literal !== url.hostname || /^\d+\.\d+\.\d+\.\d+$/.test(literal)
  // A bare name ("router", "nas") only ever resolves on the local network.
  if (isLiteral ? blockedAddress(literal) : !literal.includes('.')) {
    throw proxyError(403, 'blocked host: not on the public web')
  }
  return url
}
