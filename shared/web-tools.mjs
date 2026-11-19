/**
 * Web access for every JARVIS device: search the internet and read a page.
 *
 * Browser-safe on purpose. Each device supplies only its HTTP transport
 * (Capacitor's native client on the phone, net.mjs on the PC, a fake in
 * tests), so the same two tools exist whichever model is thinking — on-device
 * Gemma with no PC in reach included. No API key: DuckDuckGo's HTML endpoint
 * answers first, Exa's public MCP endpoint (the engine the full PC agent
 * already uses) answers when it will not.
 */

import { vetTarget } from './public-web.mjs'
import { articleBody, readableText, stripDangerous, titleOf } from './readable.mjs'

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
const MAX_REDIRECTS = 4

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—',
  euro: '€', deg: '°', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à',
  acirc: 'â', ccedil: 'ç', icirc: 'î', iuml: 'ï', ocirc: 'ô', ugrave: 'ù', ucirc: 'û',
  Eacute: 'É', Egrave: 'È', Agrave: 'À', Ccedil: 'Ç', oelig: 'œ',
}

const decode = (text) => String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
  if (code[0] !== '#') return NAMED[code] ?? NAMED[code.toLowerCase()] ?? all
  const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
  try { return String.fromCodePoint(point) } catch { return all }
})

const tidy = (text) => text.replace(/[ \t\r\f\v ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim()

/** The words of a page, without its markup, scripts or styling. */
export function htmlToText(html) {
  return tidy(decode(String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head|template|iframe|nav|header|footer|aside|form|button|select)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table)\s*>/gi, '\n')
    // Inline markup sits inside a word or against punctuation; the rest separates.
    .replace(/<\/?(a|b|i|u|em|strong|span|mark|small|sup|sub|code|abbr|font)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')))
}

/** The article when the page marks one, so a small page is not spent on menus. */
function pageText(html) {
  const body = htmlToText(/<(article|main)\b[\s\S]*<\/\1\s*>/i.exec(html)?.[0] ?? '')
  return body.length > 200 ? body : htmlToText(html)
}

/**
 * One request, redirects followed by hand so every hop is vetted again: a page
 * the model has just read chooses the next address, and the router, the PC
 * bridge and anything else private must stay out of reach.
 */
async function request(http, raw, { method = 'GET', headers = {}, data, binary = false, signal } = {}) {
  let url = vetTarget(raw)
  for (let hop = 0; ; hop++) {
    signal?.throwIfAborted()
    let stop
    // The native client cannot be cancelled; stop waiting for it instead.
    const aborted = new Promise((_, reject) => {
      stop = () => reject(signal.reason)
      signal?.addEventListener('abort', stop, { once: true })
    })
    let response
    try {
      response = await Promise.race([http({
        url: url.href, method,
        headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8', ...headers },
        ...(data === undefined ? {} : { data }),
        ...(binary ? { binary } : {}),
      }), aborted])
    } finally {
      signal?.removeEventListener('abort', stop)
    }
    const header = (name) => Object.entries(response?.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]
    const status = Number(response?.status)
    const location = header('location')
    if (status >= 300 && status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects')
      url = vetTarget(new URL(location, url).href)
      continue
    }
    return {
      status, url: url.href,
      type: String(header('content-type') ?? '').split(';')[0].trim().toLowerCase(),
      bytes: Number(header('content-length')) || undefined,
      // Capacitor parses JSON bodies itself; everything else arrives as text.
      text: typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? ''),
    }
  }
}

/**
 * The picture a page declares for itself (what a shared link shows), so the
 * model can put an image from the web on screen without guessing an address.
 */
function pageImage(html, base) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\b(property|name)\s*=\s*["']?(og:image(:secure_url|:url)?|twitter:image(:src)?)["'\s>]/i.test(tag)) continue
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    try {
      const url = vetTarget(new URL(decode(content?.[1] ?? content?.[2] ?? content?.[3] ?? '').trim(), base).href).href
      if (url.length <= 300) return url
    } catch { /* not an address; the next tag may be */ }
  }
  return ''
}

/**
 * A picture from the web as a data: address, for a screen that cannot load
 * the web itself (the phone's page without a PC bridge to proxy through).
 * The transport must answer a `binary` request with the body in base64.
 */
export async function webImage(http, url, { signal, maxBytes = 6 * 1024 * 1024 } = {}) {
  const image = await request(http, url, { signal, binary: true, headers: { Accept: 'image/*' } })
  if (image.status < 200 || image.status >= 300) throw new Error(`the site answered ${image.status}`)
  if (!image.type.startsWith('image/')) {
    throw new Error('that address is not an image file; use the Image: address web_fetch gives for a page')
  }
  const base64 = image.text.replace(/\s+/g, '')
  if (base64.length * 0.75 > maxBytes) throw new Error('that image is too large to show')
  return `data:${image.type};base64,${base64}`
}

/**
 * What is at a URL, before it is put on screen: its kind, whether it answers,
 * and for a page its title, how much prose it holds and its lead image. The
 * `suggestion` is advice from something that has only seen the bytes.
 */
export async function webProbe(http, url, { signal } = {}) {
  let head
  try {
    // HEAD first, so a picture or a video is not downloaded to learn its type.
    head = await request(http, url, { method: 'HEAD', signal }).catch(() => null)
    if (!head || head.status >= 400 || !head.type) head = await request(http, url, { signal })
  } catch (error) {
    signal?.throwIfAborted()
    return { ok: false, url, reason: error?.message ?? String(error), suggestion: 'unavailable' }
  }
  const type = head.type
  const kind = /^image\//.test(type) ? 'image' : /^video\//.test(type) ? 'video' : /^audio\//.test(type) ? 'audio'
    : /^application\/pdf/.test(type) ? 'pdf' : /^text\/html|^application\/xhtml/.test(type) ? 'page' : 'other'
  const base = { ok: head.status === 200, url: head.url, status: head.status, contentType: type, bytes: head.bytes, kind }
  if (kind === 'image') return { ...base, suggestion: base.ok ? 'blade_image' : 'unavailable' }
  if (kind === 'video' || kind === 'audio') return { ...base, suggestion: base.ok ? 'blade_video' : 'unavailable' }
  if (kind === 'pdf') return { ...base, suggestion: base.ok ? 'blade_pdf' : 'unavailable' }
  if (kind !== 'page' || !base.ok) return { ...base, suggestion: base.ok ? 'speak_only' : 'unavailable' }
  try {
    const page = head.text ? head : await request(http, head.url, { signal })
    // Measured as the reading view measures, so a reader is only suggested when it will have words in it.
    const readable = readableText(articleBody(stripDangerous(page.text)))
    return {
      ...base,
      title: titleOf(page.text),
      readableChars: readable.length,
      leadImage: pageImage(page.text, page.url) || null,
      excerpt: readable.slice(0, 300),
      // Enough prose to read gets the reading view; a page that is mostly
      // interface is only itself when it looks like itself.
      suggestion: readable.length > 900 ? 'blade_reader' : 'blade_live',
    }
  } catch (error) {
    signal?.throwIfAborted()
    return { ...base, suggestion: 'blade_live', reason: error?.message ?? String(error) }
  }
}

async function duckduckgo(http, query, signal) {
  const page = await request(http, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal })
  if (page.status !== 200) throw new Error(`answered ${page.status}`)
  const results = []
  for (const part of page.text.split('class="result__a"').slice(1)) {
    const link = /href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(part)
    if (!link) continue
    let url
    try {
      const href = new URL(decode(link[1]), 'https://duckduckgo.com')
      url = href.searchParams.get('uddg') ?? href.href
    } catch { continue }
    // Sponsored links go through y.js and carry no destination.
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(part)
    results.push({ title: htmlToText(link[2]), url, snippet: htmlToText(snippet?.[1] ?? '') })
  }
  return results
}

async function exa(http, query, signal) {
  const page = await request(http, 'https://mcp.exa.ai/mcp', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query, numResults: 4 } } },
  })
  if (page.status !== 200) throw new Error(`answered ${page.status}`)
  // Either one JSON document or a server-sent event carrying it.
  const body = page.text.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5) ?? page.text
  const reply = JSON.parse(body)
  if (reply.error || reply.result?.isError) throw new Error(reply.error?.message ?? 'refused the search')
  return tidy((reply.result?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n'))
}

/**
 * @param {(request: { url: string, method: string, headers: Record<string, string>, data?: unknown, binary?: boolean }) =>
 *   Promise<{ status: number, headers?: Record<string, string>, data: unknown }>} http
 *   Must NOT follow redirects itself. `binary` is only asked by webImage.
 * @param {{ limit?: number }} [options]  Characters one result may occupy in the model's context.
 */
export function webTools(http, { limit = 5000 } = {}) {
  return [
    {
      name: 'web_search',
      description: 'Search the internet: titles, addresses and excerpts.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async run({ query }, { signal } = {}) {
        const words = String(query ?? '').trim()
        if (!words) throw new Error('Give the words to search for')
        const failures = []
        try {
          const results = await duckduckgo(http, words, signal)
          let out = ''
          for (const [i, result] of results.slice(0, 6).entries()) {
            const entry = `${i + 1}. ${result.title}\n${result.url}${result.snippet ? `\n${result.snippet.slice(0, 200)}` : ''}\n`
            if (out && out.length + entry.length > limit) break
            out += entry
          }
          if (out) return out.slice(0, limit).trim()
          failures.push('DuckDuckGo: no results')
        } catch (err) {
          if (signal?.aborted) throw err
          failures.push(`DuckDuckGo: ${err?.message ?? err}`)
        }
        try {
          const text = await exa(http, words, signal)
          if (text) return text.length > limit ? `${text.slice(0, limit)}…` : text
          failures.push('Exa: no results')
        } catch (err) {
          if (signal?.aborted) throw err
          failures.push(`Exa: ${err?.message ?? err}`)
        }
        throw new Error(`the web search returned nothing (${failures.join(' ; ')}). The phone may be offline.`)
      },
    },
    {
      name: 'web_fetch',
      description: 'Read a web page as text, continuing from character offset from. Its Image: line is the page’s picture address.',
      parameters: { type: 'object', properties: { url: { type: 'string' }, from: { type: 'number' } }, required: ['url'] },
      async run({ url, from }, { signal } = {}) {
        const page = await request(http, url, {
          signal, headers: { Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' },
        })
        if (page.status < 200 || page.status >= 300) throw new Error(`the site answered ${page.status}`)
        if (page.type && !/^(text\/|application\/([\w.-]+\+)?(json|xml)$)/.test(page.type)) {
          return `This is a ${page.type} file; its text cannot be read here.`
        }
        const markup = /html|xml/.test(page.type) || /^\s*<(!doctype|html)\b/i.test(page.text)
        const title = markup ? htmlToText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.text)?.[1] ?? '') : ''
        const all = markup ? pageText(page.text) : page.text.trim()
        const start = Math.max(0, Math.floor(Number(from) || 0))
        const image = markup ? pageImage(page.text, page.url) : ''
        const head = start ? '' : `${title ? `${title.slice(0, 120)}\n` : ''}${page.url.slice(0, 200)}\n${image ? `Image: ${image}\n` : ''}`
        const part = all.slice(start, start + Math.max(200, limit - head.length - 70))
        const end = start + part.length
        return head + (part || '[No readable text here; the page may need JavaScript.]') +
          (end < all.length ? `\n[${all.length - end} more characters; continue with from=${end}]` : '')
      },
    },
  ]
}
