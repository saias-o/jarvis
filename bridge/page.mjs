import { randomBytes } from 'node:crypto'
import { fetchText, proxyError } from './net.mjs'
import { articleBody, escape, metaContent, stripDangerous, textOf, titleOf } from '../shared/readable.mjs'

/**
 * Showing a web page on the display.
 *
 * The problem this solves is specific and, until now, unsolvable from the
 * browser side. JARVIS finds an article and wants to put it on screen. Three
 * separate mechanisms stop him:
 *
 *   1. `X-Frame-Options: DENY` / `frame-ancestors` — most publishers refuse to
 *      be framed at all, so an <iframe> pointed at the article is a blank box.
 *   2. CORS — the page cannot fetch the article's HTML to render it itself.
 *   3. Hotlink blocking — even the images inside it 403 for anything that is
 *      not the publisher's own page.
 *
 * All three are the *origin server's* rules about who may load its content, and
 * all three are enforced against the browser. So we take the browser out of it.
 * The bridge fetches the document server-side and serves it back from
 * http://localhost:8787, and at that point the page in the iframe is, as far as
 * the browser is concerned, ours. There is no cross-origin request to refuse, no
 * frame-ancestors to violate, and no CORS preflight to fail. The publisher's
 * headers are not bypassed so much as made irrelevant — they were never about
 * this machine reading the article, which is a thing the user is entitled to do.
 *
 * Two modes, because "show me the article" means two different things:
 *
 *   reader — the words, restyled into this interface. Always legible, never
 *            looks like the source. Nothing loads from the publisher at all;
 *            even the images come back through the bridge's own /img.
 *   live   — the real page, scripts removed. Looks like the site, because
 *            sometimes the layout IS the information. Its own stylesheets and
 *            images load from the publisher, so this mode does tell the
 *            publisher that somebody read it — which is exactly as true as it
 *            would be if the user had opened the tab themselves.
 */

/**
 * The one script allowed to run inside a proxied page.
 *
 * A blade shows articles in an iframe, and an iframe is its own document — the
 * parent cannot scroll it, cannot reach into it, and must not be able to. That
 * is correct for safety and inconvenient for reading: a hand has no scroll
 * wheel, so without a channel the only way through a long article is a mouse.
 *
 * So the page gets one listener, injected by us, that scrolls on request and
 * does nothing else. It is admitted by nonce rather than by 'unsafe-inline', so
 * this exact script runs and anything the publisher shipped does not — and the
 * frame is sandboxed WITHOUT allow-same-origin, so the script executes in an
 * opaque origin that cannot touch this application even though it can move its
 * own scroll position.
 */
const SCROLL_SHIM = `
addEventListener('message', function (e) {
  var d = e.data
  if (!d || d.jarvis !== 'scroll') return
  if (d.to === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); return }
  if (d.to === 'bottom') { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); return }
  window.scrollBy({ top: d.dy || 0, behavior: d.smooth ? 'smooth' : 'auto' })
})
// Announce, so the blade knows the listener exists rather than posting into a
// document that has rendered but not yet run anything. Without this the first
// scroll of every article is silently dropped, which reads as scrolling being
// broken rather than early.
try { parent.postMessage({ jarvis: 'ready' }, '*') } catch (e) {}
`

const MAX_PAGE_BYTES = 8 * 1024 * 1024
const PAGE_TIMEOUT_MS = 15_000

/** Absolute-ise a URL found in the document against the page it came from. */
function absolute(href, base) {
  try {
    return new URL(href, base).href
  } catch {
    return null
  }
}

/**
 * Pull the readable article out and rebuild it in this interface's own type.
 *
 * Everything that survives is a heading, a paragraph or an image; anything else
 * was furniture. Images are rewritten through /img so that even in reading mode
 * the browser never talks to the publisher.
 */
function toReader(html, pageUrl, bridgeOrigin, sign) {
  // Through the bridge's /img, signed when the caller says the frame's own
  // requests will arrive without credentials (see remote.mjs).
  const viaBridge = (abs) =>
    `${bridgeOrigin}/img?url=${encodeURIComponent(abs)}` + (sign ? `&amp;sig=${sign(abs)}` : '')
  const clean = stripDangerous(html)
  const body = articleBody(clean)
  const title = titleOf(html)
  const lead = metaContent(html, ['og:image', 'twitter:image'])

  const blocks = []
  /**
   * List items are only content once prose has started.
   *
   * A run of <li> before the first paragraph is, essentially without exception,
   * metadata: an infobox, a breadcrumb trail, a set of category links, a table
   * of contents. After a paragraph has been seen the same markup is a list
   * *in* the article and belongs. This one bit of state is the difference
   * between a Wikipedia article opening on its first sentence and opening on
   * "Stan Lee (editor/concept), Larry Lieber (writer)".
   */
  let seenProse = false
  const pattern = /<(h1|h2|h3|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>|<img\b([^>]*)>/gi
  let m
  while ((m = pattern.exec(body)) !== null) {
    if (m[3] !== undefined) {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[3])?.[1]
      const abs = src ? absolute(src, pageUrl) : null
      // Spacers, tracking pixels and sprite sheets all arrive as <img>; a data
      // URI here is almost always one of those rather than a photograph.
      if (abs && /^https?:/i.test(abs)) {
        blocks.push(
          `<img class="rd-img" loading="lazy" src="${viaBridge(abs)}" alt="">`,
        )
      }
      continue
    }
    const tag = m[1].toLowerCase()
    const text = textOf(m[2])
    if (!text || text.length < 2) continue
    if (tag === 'li') {
      if (!seenProse) continue
      blocks.push(`<li class="rd-li">${escape(text)}</li>`)
    } else if (tag === 'blockquote') {
      blocks.push(`<blockquote class="rd-q">${escape(text)}</blockquote>`)
    } else if (tag === 'p') {
      // Two words is a caption or a byline fragment, not the body starting.
      if (text.split(/\s+/).length > 8) seenProse = true
      blocks.push(`<p class="rd-p">${escape(text)}</p>`)
    } else {
      blocks.push(`<${tag} class="rd-h">${escape(text)}</${tag}>`)
    }
  }

  const leadImg =
    lead && /^https?:/i.test(lead)
      ? `<img class="rd-lead" src="${viaBridge(lead)}" alt="">`
      : ''

  const host = (() => {
    try {
      return new URL(pageUrl).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  })()

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title || host)}</title>
<style>
  :root { color-scheme: dark; }
  html,body { margin:0; background:transparent; }
  body {
    font: 400 15px/1.62 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
    color: #cfe9ee; padding: 18px 22px 40px;
    -webkit-font-smoothing: antialiased;
  }
  .rd-src { font: 500 10px/1 ui-monospace, monospace; letter-spacing:.16em;
            text-transform:uppercase; color:#5fd8e0; opacity:.8; }
  .rd-title { font-size: 25px; line-height:1.2; font-weight:600; color:#eafcff;
              margin: 10px 0 18px; }
  .rd-h { font-size: 16px; color:#eafcff; margin: 22px 0 8px; font-weight:600; }
  .rd-p { margin: 0 0 14px; }
  .rd-li { margin: 0 0 7px 18px; }
  .rd-q { margin: 16px 0; padding-left: 14px; border-left: 2px solid #19c4c4;
          color:#9fdbe2; font-style: italic; }
  img { max-width:100%; height:auto; display:block; border-radius:4px;
        margin: 14px 0; }
  .rd-lead { margin-bottom: 18px; }
  ::-webkit-scrollbar { width: 9px; }
  ::-webkit-scrollbar-thumb { background: #19c4c455; border-radius: 9px; }
</style></head><body>
<div class="rd-src">${escape(host)}</div>
<h1 class="rd-title">${escape(title)}</h1>
${leadImg}
${blocks.join('\n') || '<p class="rd-p">Nothing readable could be extracted from this page.</p>'}
</body></html>`
}

/**
 * The real page, with everything that can execute taken out.
 *
 * `<base>` is what makes this work at all: with the original URL as the base,
 * every relative stylesheet, image and font in the document resolves back to
 * the publisher and loads normally, so the page looks like itself. What it
 * cannot do is run — the response carries `script-src 'none'` and every
 * <script> is gone from the markup before it is served.
 */
function toLive(html, pageUrl) {
  let out = stripDangerous(html)
  // Anything the page said about its own framing or transport belongs to a
  // context that no longer exists, and a stale <base> would send every relative
  // URL somewhere we did not choose.
  out = out.replace(/<base\b[^>]*>/gi, '')
  const injected =
    `<base href="${escape(pageUrl)}">` +
    '<style>html{background:#06101a;color-scheme:dark}' +
    '::-webkit-scrollbar{width:9px}::-webkit-scrollbar-thumb{background:#19c4c455;border-radius:9px}</style>'
  if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, (h) => `${h}${injected}`)
  } else {
    out = `<!doctype html><html><head><meta charset="utf-8">${injected}</head><body>${out}</body></html>`
  }
  return out
}

/**
 * Serve a page. Returns { body, headers } ready to write.
 *
 * @param {string} url
 * @param {'reader'|'live'} mode
 * @param {string} bridgeOrigin  e.g. http://localhost:8787
 * @param {(url: string) => string} [sign]  signs each image URL, when given
 */
export async function renderPage(url, mode, bridgeOrigin, sign) {
  const page = await fetchText(url, {
    maxBytes: MAX_PAGE_BYTES,
    timeoutMs: PAGE_TIMEOUT_MS,
  })
  if (!/^text\/html|^application\/xhtml/.test(page.type)) {
    throw proxyError(415, `not a web page (got ${page.type || 'nothing'})`)
  }

  const live = mode === 'live'
  const nonce = randomBytes(16).toString('base64')
  const shim = `<script nonce="${nonce}">${SCROLL_SHIM}</script>`
  const rendered = live
    ? toLive(page.text, page.url)
    : toReader(page.text, page.url, bridgeOrigin, sign)
  // Appended rather than injected into <head>: by this point every other script
  // is gone, so there is nothing for it to race, and </body> is somewhere every
  // one of these documents actually has.
  const body = rendered.includes('</body>')
    ? rendered.replace('</body>', `${shim}</body>`)
    : rendered + shim

  // The framed document's own policy. The parent page's CSP does not reach in
  // here — an iframe gets its rules from its own response — so this is the only
  // thing standing between a hostile page and script execution on an origin
  // that is allowed to open the agent socket.
  const csp = live
    ? "default-src 'none'; img-src https: http: data: blob:; " +
      "style-src 'unsafe-inline' https: http: data:; font-src https: http: data:; " +
      `media-src https: http: data:; script-src 'nonce-${nonce}'; form-action 'none'; ` +
      "frame-src 'none'; object-src 'none'; base-uri 'none'"
    : `default-src 'none'; img-src ${bridgeOrigin} data:; ` +
      `style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'none'; ` +
      "frame-src 'none'; object-src 'none'; base-uri 'none'"

  return {
    body,
    title: titleOf(page.text),
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      referrerpolicy: 'no-referrer',
      /**
       * Not cached, deliberately.
       *
       * A proxied article is read once and the bytes are cheap to re-fetch, so
       * caching buys very little. What it costs is real: the document carries a
       * per-response CSP nonce and an injected script, and a cached copy is a
       * frozen pairing of both. During development that meant iframes silently
       * replaying a version of the page from before the scroll shim existed —
       * scrolling appeared broken while the freshly served bytes were perfect,
       * which took far longer to find than the feature took to write.
       */
      'cache-control': 'no-store',
    },
  }
}
