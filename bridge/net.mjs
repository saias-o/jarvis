// The outbound side of the bridge, and the gate in front of it.
//
// This process — unlike a browser tab — can reach the user's LAN, their
// router's admin page and cloud metadata endpoints, and everything it fetches
// is fetched at a URL some model chose while reading the open web. So every
// outbound request goes through here, and here is an SSRF gate first and a
// fetch second.
//
// It lives in its own file because there are now two callers with genuinely
// different jobs — the media proxy that streams bytes to an <img> or <video>,
// and the page proxy that reads whole documents — and the one thing neither of
// them may be allowed to reimplement is the gate.
//
// Built on the low-level http/https clients rather than fetch() on purpose: it
// needs a per-connection DNS hook to stop rebinding, manual control of every
// redirect hop, and a body it can stream and cut off mid-flight.

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns'
import { blockedAddress, proxyError, vetTarget } from '../shared/public-web.mjs'

// One gate for the bridge and the phone: the rules live in shared/public-web.mjs.
export { blockedAddress, proxyError, vetTarget }

/** A redirect chain longer than this is a loop or a game, not a CDN. */
export const MAX_REDIRECTS = 4

/**
 * A perfectly ordinary desktop browser, which is the entire point: the hosts we
 * are fetching from serve placeholders to anything that looks automated, and a
 * thumbnail that 403s is the bug we are here to fix. No Referer is sent and the
 * browser's own cookies never come near this, so nothing about the user leaks
 * upstream beyond the fact that some machine asked for a public page.
 */
export const PROXY_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' +
  ' (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/**
 * The DNS hook every outbound socket goes through.
 *
 * Checking the address *after* resolving and then letting net.connect resolve
 * again would leave a rebinding window — the second answer is free to be
 * 127.0.0.1. So we resolve once here, refuse the whole name if ANY answer is
 * private, and hand the vetted address straight to the connect call, which then
 * does no lookup of its own. Strict on purpose: a public host that also
 * advertises a LAN address is not a host we need to be able to reach.
 */
export function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : (options ?? {})
  const done = typeof options === 'function' ? options : callback
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return done(err)
    const list = Array.isArray(addresses) ? addresses : [addresses]
    if (!list.length) return done(new Error('no address'))
    for (const entry of list) {
      if (blockedAddress(entry.address)) {
        const blocked = new Error(
          `refusing ${hostname}: resolves to the private address ${entry.address}`,
        )
        blocked.code = 'EBLOCKEDADDRESS'
        return done(blocked)
      }
    }
    if (opts.all) return done(null, list)
    return done(null, list[0].address, list[0].family)
  })
}

/** One hop. Resolves with the IncomingMessage once headers are in. */
export function requestOnce(url, headers, timeoutMs, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method,
      headers,
      // The SSRF gate. Everything else here is plumbing.
      lookup: guardedLookup,
    })
    // Two different clocks, deliberately. This one is the deadline for getting
    // headers back at all — a host that accepts the connection and then says
    // nothing must not hold a panel open for ever.
    const deadline = setTimeout(() => {
      req.destroy(proxyError(504, 'upstream timed out'))
    }, timeoutMs)
    // And this one is idle-socket: once the body is flowing, a 200 MB video is
    // allowed to take longer than 30 seconds as long as bytes keep arriving.
    req.setTimeout(timeoutMs, () => {
      req.destroy(proxyError(504, 'upstream stalled'))
    })
    req.on('response', (res) => {
      clearTimeout(deadline)
      resolve(res)
    })
    req.on('error', (err) => {
      clearTimeout(deadline)
      reject(
        err.code === 'EBLOCKEDADDRESS'
          ? proxyError(403, 'blocked host')
          : err.status
            ? err
            : proxyError(502, 'upstream unreachable'),
      )
    })
    req.end(body)
  })
}

/**
 * Follow redirects by hand rather than letting a client library do it, because
 * every hop has to be vetted again: a public URL that 302s to
 * http://169.254.169.254/ is the whole SSRF attack, and a redirect to
 * file:// or data: is the other half of it.
 */
export async function openRemote(startUrl, headers, timeoutMs) {
  let url = startUrl
  for (let hop = 0; ; hop++) {
    const res = await requestOnce(url, headers, timeoutMs)
    const status = res.statusCode ?? 0
    const location = res.headers.location
    if (status >= 300 && status < 400 && location) {
      res.resume() // drain, or the socket never returns to the pool
      if (hop >= MAX_REDIRECTS) throw proxyError(502, 'too many redirects')
      let next
      try {
        next = new URL(location, url)
      } catch {
        throw proxyError(502, 'bad redirect')
      }
      // vetTarget re-runs the scheme and host checks; guardedLookup re-runs the
      // address check when the next hop connects.
      url = vetTarget(next.href)
      continue
    }
    return { res, url }
  }
}

/**
 * Read a whole response as text, with a hard cap.
 *
 * Separate from the streaming proxy because a document is not media: we need
 * all of it in hand before we can rewrite it, and a page that will not fit in
 * the cap is one we should decline rather than truncate — half an HTML document
 * parses into something arbitrary.
 */
export async function fetchText(url, { maxBytes, timeoutMs, accept }) {
  const target = vetTarget(url)
  const { res, url: finalUrl } = await openRemote(
    target,
    {
      'user-agent': PROXY_UA,
      accept: accept ?? 'text/html,application/xhtml+xml,*/*;q=0.8',
      'accept-language': 'en-GB,en;q=0.9',
      'accept-encoding': 'identity',
    },
    timeoutMs,
  )

  const status = res.statusCode ?? 0
  const type = String(res.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()

  if (status !== 200) {
    res.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const { text, bytes } = await readBody(res, maxBytes)
  return { text, type, url: finalUrl.href, headers: res.headers, bytes }
}

/** A whole body as text in its own character set, refused past the cap. */
async function readBody(res, maxBytes) {
  const chunks = []
  let bytes = 0
  for await (const chunk of res) {
    bytes += chunk.length
    if (bytes > maxBytes) {
      res.destroy()
      throw proxyError(413, 'page too large')
    }
    chunks.push(chunk)
  }

  // Character set matters more here than anywhere else in the bridge: a page
  // decoded as UTF-8 when it is really windows-1252 turns every quotation mark
  // in the article into a replacement glyph, which looks like our bug.
  const raw = Buffer.concat(chunks)
  const declared = /charset=["']?([\w-]+)/i.exec(String(res.headers['content-type'] ?? ''))
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(raw.subarray(0, 4096).toString('latin1'))
  const charset = (declared?.[1] ?? meta?.[1] ?? 'utf-8').toLowerCase()
  let text
  try {
    text = new TextDecoder(charset).decode(raw)
  } catch {
    text = raw.toString('utf8')
  }
  return { text, bytes }
}

/**
 * The PC's transport for the shared web tools (shared/web-tools.mjs).
 *
 * Exactly one exchange: those tools follow redirects themselves, vetting each
 * hop, and the DNS hook in requestOnce vets the address every hop resolves to.
 */
export async function webExchange({ url, method = 'GET', headers = {}, data }) {
  const body = data === undefined ? undefined : JSON.stringify(data)
  const res = await requestOnce(
    vetTarget(url),
    {
      ...headers,
      'accept-encoding': 'identity',
      ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
    },
    20_000,
    { method, body },
  )
  const { text } = await readBody(res, 4 * 1024 * 1024)
  return { status: res.statusCode ?? 0, headers: res.headers, data: text }
}
