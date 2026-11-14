import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Reaching JARVIS from another device — a phone, mostly.
 *
 * The bridge's ordinary port answers this machine only, and trusts whatever
 * arrives on it from a local dev origin. That is the right rule for a socket on
 * loopback and the wrong one for anything a second device can reach, so remote
 * access does not loosen it. It gets a port of its own with its own rules:
 *
 *   - It still listens on loopback. Something else carries it off the machine —
 *     `tailscale serve`, which puts it on the owner's private tailnet behind
 *     real TLS. The bridge never binds a public interface.
 *   - Who gets in is the owner's choice between two locks. By default every
 *     device gives the access code once and keeps a long-lived cookie. With
 *     JARVIS_REMOTE_CODE=off there is nothing to type: the proxy says which
 *     Tailscale account each request came from, and only the owner's is let
 *     in. That is one lock fewer — a device signed in to the tailnet IS the
 *     key — and it is the right trade for someone who would otherwise be
 *     locked out of their own assistant while away from the computer.
 *   - It serves the built interface itself, so the page, the socket and the
 *     media endpoints share one origin. That is what lets the cookie ride on
 *     <img>, <iframe> and the WebSocket handshake without any of them knowing.
 *
 * Kept apart from server.mjs so the rules can be tested without an agent.
 */

export const REMOTE_FILE = resolve(
  process.env.JARVIS_REMOTE_FILE ?? join(homedir(), '.jarvis', 'remote.json'),
)

const COOKIE = 'jarvis_access'
/** Browsers cap a cookie's life at 400 days; ask for all of it. */
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60

/** No 0/O, 1/I/L — the code is read off one screen and typed on another. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

export function newCode() {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return out
}

/** What a person typed, reduced to what was issued: case and dashes are noise. */
export const normaliseCode = (raw) =>
  String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')

/** XXXX-XXXX, for reading aloud or off a terminal. */
export const prettyCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`

/**
 * The code and the signing secret, created on first use and kept beside the
 * memory file — outside the agent's workspace, so no file tool can read them.
 * Deleting the file revokes every device at once.
 */
export function loadSecrets(file = REMOTE_FILE) {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (
      typeof saved.code === 'string' &&
      normaliseCode(saved.code).length >= CODE_LENGTH &&
      typeof saved.secret === 'string' &&
      saved.secret.length >= 32
    ) {
      return { code: normaliseCode(saved.code), secret: saved.secret }
    }
  } catch {
    /* missing or unreadable: issue a new pair */
  }
  const fresh = { code: newCode(), secret: randomBytes(32).toString('hex') }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(fresh, null, 2) + '\n', { mode: 0o600 })
  return fresh
}

const sameBytes = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
}

const lowered = (list) => new Set(list.map((s) => String(s).trim().toLowerCase()).filter(Boolean))

/**
 * @param {object} opts
 * @param {string[]} opts.hosts        Names the remote port answers to, besides loopback.
 * @param {string}   opts.faceDir      The built interface (vite's `dist`).
 * @param {string}  [opts.file]        Where the code and secret live.
 * @param {boolean} [opts.requireCode] False drops the access code entirely.
 * @param {string[]} [opts.users]      Tailscale logins a proxied request must come from.
 */
export function createRemote({ hosts = [], faceDir, file = REMOTE_FILE, requireCode = true, users = [], origins = [] }) {
  // With no code there is nothing to keep, so no file is written either.
  const { code, secret } = requireCode ? loadSecrets(file) : { code: '', secret: '' }
  const allowed = lowered(hosts)
  const owners = lowered(users)
  const appOrigins = new Set(origins.map((value) => {
    if (!value.trim()) return ''
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.origin !== value.trim()) throw new Error('JARVIS_REMOTE_ORIGINS must contain exact HTTPS origins')
    return url.origin
  }).filter(Boolean))
  const isApp = (req) => appOrigins.has(String(req.headers.origin ?? ''))
  const cors = (req) => isApp(req) ? {
    'access-control-allow-origin': req.headers.origin,
    'access-control-allow-methods': 'GET, HEAD, POST, PUT, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'vary': 'Origin',
  } : {}
  const face = resolve(faceDir)

  const mac = (what) => createHmac('sha256', secret).update(what).digest('hex')
  // Bound to the code, so issuing a new code signs every device out.
  const token = requireCode ? mac(`cookie:${code}`) : ''

  /**
   * The name the client used, from Host and nothing else. `tailscale serve`
   * preserves it (measured), and it is the one header a web page cannot forge:
   * a page that has re-pointed its own name at this port still announces that
   * name here. X-Forwarded-Host is no such thing — any same-origin fetch can
   * set it — so it is deliberately not consulted.
   */
  const hostOf = (req) => String(req.headers.host ?? '').toLowerCase()
  const nameOf = (host) => {
    try {
      return new URL(`http://${host}`).hostname.toLowerCase()
    } catch {
      return ''
    }
  }
  const isLoopback = (host) => LOOPBACK_NAMES.has(nameOf(host))

  const hostAllowed = (req) => {
    const name = nameOf(hostOf(req))
    return Boolean(name) && (LOOPBACK_NAMES.has(name) || allowed.has(name))
  }

  /** Where the browser believes this page lives — scheme and all. */
  const originOf = (req) => {
    const host = hostOf(req)
    const proto =
      String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() ||
      (isLoopback(host) ? 'http' : 'https')
    return `${proto === 'https' ? 'https' : 'http'}://${host}`
  }

  /**
   * Same-origin only. The interface is served from this port, so nothing but
   * this port's own page has any business calling it. A request with no Origin
   * is an <img>, an <iframe> or a navigation, and is judged on its cookie.
   */
  const originAllowed = (req, origin = req.headers.origin) => {
    if (!origin) return true
    if (appOrigins.has(origin)) return true
    try {
      return new URL(origin).host.toLowerCase() === hostOf(req)
    } catch {
      return false
    }
  }

  /**
   * Whose request this is, when a proxy carried it here.
   *
   * `tailscale serve` stamps every request with the account it came from and
   * strips any copy the client sent, so across the tailnet the header cannot
   * be forged. Anything that arrived through a proxy — it says so with
   * X-Forwarded-For — has to carry an owner's login; a request with neither is
   * a browser on this machine talking to loopback directly, which the Host and
   * Origin rules have already judged. A caller who invents the proxy headers
   * only talks themselves into the stricter branch.
   */
  const userAllowed = (req) => {
    if (isApp(req)) {
      const login = String(req.headers['tailscale-user-login'] ?? '').trim().toLowerCase()
      return owners.size > 0 && owners.has(login)
    }
    if (owners.size === 0) return true
    const login = String(req.headers['tailscale-user-login'] ?? '').trim().toLowerCase()
    const proxied = Boolean(login) || req.headers['x-forwarded-for'] !== undefined
    return !proxied || owners.has(login)
  }

  const authed = (req) => {
    if (!requireCode) return true
    const protocol = String(req.headers['sec-websocket-protocol'] ?? '').split(',')
      .map((s) => s.trim()).find((s) => s.startsWith('jarvis-access.'))
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization ?? ''))?.[1]
    const got = isApp(req) ? bearer ?? protocol?.slice('jarvis-access.'.length) ?? cookieOf(req, COOKIE) : cookieOf(req, COOKIE)
    return got !== null && sameBytes(got, token)
  }

  /**
   * Images inside a proxied article cannot carry the cookie: the article is
   * framed in a sandbox with no origin of its own, so everything it loads is
   * cross-site as far as the browser is concerned. Those URLs are written by
   * the bridge, so the bridge signs them, and a signed URL fetches exactly the
   * one image it names.
   */
  const signImage = (url) => mac(`img:${url}`).slice(0, 32)
  const imageSigned = (req) => {
    if (!requireCode) return false
    const asked = new URL(req.url ?? '/', 'http://x')
    if (asked.pathname !== '/img') return false
    const sig = asked.searchParams.get('sig')
    const url = asked.searchParams.get('url')
    return Boolean(sig && url) && sameBytes(sig, signImage(url))
  }

  /**
   * Guessing has to be slower than giving up. Five wrong codes and the door
   * stays shut until the oldest of them is five minutes old — at that rate the
   * forty bits in the code are out of reach, and the owner mistyping it twice
   * on a phone keyboard never notices the limit exists. Counted for everyone
   * together, because behind a proxy every caller looks like 127.0.0.1.
   */
  const MAX_FAILURES = 5
  const WINDOW_MS = 5 * 60 * 1000
  let failures = []

  const tryCode = (raw, now = Date.now()) => {
    if (!requireCode) return 'ok'
    failures = failures.filter((t) => now - t < WINDOW_MS)
    if (failures.length >= MAX_FAILURES) return 'locked'
    if (sameBytes(normaliseCode(raw), code)) return 'ok'
    failures.push(now)
    return 'wrong'
  }

  const cookieHeader = (req) =>
    `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict` +
    // Plain http only ever happens on loopback, where Secure would stop the
    // cookie being stored at all in some browsers.
    (originOf(req).startsWith('https:') ? '; Secure' : '')

  /** Serve one file of the built interface. Resolves false if there is none. */
  async function serveFace(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    let path
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    } catch {
      return false
    }
    if (path.includes('\0')) return false

    const pick = async (rel) => {
      const full = resolve(face, `.${rel}`)
      const within = relative(face, full)
      if (within.startsWith('..') || isAbsolute(within)) return null
      try {
        const info = await stat(full)
        return info.isFile() ? { full, info } : null
      } catch {
        return null
      }
    }

    // A path with no extension is the app itself; one with an extension that
    // is not on disk is simply missing, and must not come back as HTML.
    const found =
      (await pick(path === '/' ? '/index.html' : path)) ??
      (extname(path) ? null : await pick('/index.html'))
    if (!found) return false

    const ext = extname(found.full).toLowerCase()
    res.writeHead(200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'content-length': String(found.info.size),
      'x-content-type-options': 'nosniff',
      // Vite fingerprints everything under /assets, so those never change;
      // the shell is revalidated so a rebuild shows up on the next launch.
      'cache-control': path.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    })
    if (req.method === 'HEAD') {
      res.end()
      return true
    }
    await new Promise((done) => {
      const stream = createReadStream(found.full)
      stream.on('error', () => {
        res.destroy()
        done()
      })
      stream.on('end', done)
      stream.pipe(res)
    })
    return true
  }

  return {
    code,
    requireCode,
    restrictedToUsers: owners.size > 0,
    hosts: [...allowed],
    userAllowed,
    cors,
    appToken: (req) => isApp(req) && requireCode ? token : undefined,
    faceBuilt: () => existsSync(join(face, 'index.html')),
    hostAllowed,
    originAllowed,
    originOf,
    authed,
    imageSigned,
    signImage,
    tryCode,
    cookieHeader,
    serveFace,
  }
}
