/**
 * Reading a web page without a DOM: what is dangerous, what is furniture,
 * where the article is and how much prose it holds.
 *
 * One implementation for the PC's reading view (bridge/page.mjs) and for the
 * probe every device runs before showing a URL (shared/web-tools.mjs), so the
 * probe never recommends a reading view the renderer cannot fill.
 *
 * Browser-safe: the phone runs this inside its WebView.
 */

// ---------------------------------------------------------------------------
// Cheap HTML surgery
//
// No DOM parser here on purpose: adding jsdom to a project whose entire pitch
// is "one npm install and it runs" is a poor trade for a reading view. These
// are deliberately blunt, and the failure mode is chosen to be safe — a regex
// that over-matches removes too much and the article reads a little bare; one
// that under-matches would leave a <script> in, so every pattern below errs
// toward removing.
// ---------------------------------------------------------------------------

/** Elements whose entire subtree is noise, or worse. */
const KILL = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'form',
  'iframe', 'object', 'embed', 'applet', 'link', 'meta',
]

export function stripDangerous(html) {
  let out = html.replace(/<!--[\s\S]*?-->/g, '')
  for (const tag of KILL) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), '')
    // Void and unclosed forms of the same tags.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '')
  }
  // Inline event handlers, and the two URL schemes that are code.
  out = out.replace(/\son[a-z]+\s*=\s*(["'])[\s\S]*?\1/gi, '')
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
  out = out.replace(/(href|src|action|poster)\s*=\s*(["'])\s*(javascript|data:text\/html|vbscript):[\s\S]*?\2/gi, '$1="#"')
  return out
}

export const textOf = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()

export const escape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export function metaContent(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*>`,
      'i',
    )
    const tag = re.exec(html)?.[0]
    if (!tag) continue
    const value = /content\s*=\s*["']([\s\S]*?)["']/i.exec(tag)?.[1]
    if (value) return textOf(value)
  }
  return ''
}

export function titleOf(html) {
  return (
    metaContent(html, ['og:title', 'twitter:title']) ||
    textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') ||
    ''
  )
}

/**
 * Furniture: whole subtrees that are never the article.
 *
 * Stripped before anything is scored, because a navigation region sitting
 * inside <main> is otherwise indistinguishable from content by any measure of
 * size — and on a site whose sidebar is a list of a hundred language names, it
 * is *larger* than the article. That was not hypothetical: the reading view of
 * a Wikipedia page opened on "Afrikaans, العربية, অসমীয়া" and never reached a
 * sentence.
 */
export function stripFurniture(html) {
  let out = html
  for (const tag of ['nav', 'aside', 'header', 'footer']) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), '')
  }
  return out
}

/** The text inside a container that is actually prose, in characters. */
export function proseLength(html) {
  let total = 0
  for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    total += textOf(m[1]).length
  }
  return total
}

/**
 * Find the element that actually holds the article.
 *
 * Scored on how much of a container is *prose* rather than on how big it is.
 * That distinction is the whole algorithm: the largest block on any news page
 * is reliably the entire page, and the largest list is reliably the navigation.
 * Paragraph text is the one signal that separates an article from a menu with
 * the same character count.
 *
 * Deliberately generic. There is no site-specific selector anywhere in here —
 * the moment this file starts naming publishers it becomes a thing that has to
 * be maintained against the web, and it will lose.
 */
export function articleBody(html) {
  const clean = stripFurniture(html)

  const candidates = []
  const add = (fragment) => {
    if (!fragment) return
    const prose = proseLength(fragment)
    if (prose > 200) candidates.push({ fragment, prose })
  }

  for (const m of clean.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) add(m[1])
  for (const m of clean.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main>/gi)) add(m[1])
  // Divs and sections too, so a page that uses neither semantic element — still
  // most of the web — is not stuck with the whole document.
  for (const m of clean.matchAll(/<(?:div|section)\b[^>]*>([\s\S]*?)<\/(?:div|section)>/gi)) {
    add(m[1])
  }

  if (candidates.length) {
    // Densest wins, and on a tie the smaller one: nested containers all match,
    // and the innermost is the one that is only the article.
    candidates.sort((a, b) => b.prose - a.prose || a.fragment.length - b.fragment.length)
    const best = candidates[0]
    // Among containers within a whisker of the best score, prefer the tightest
    // — an outer wrapper scores identically to the article it wraps.
    const tight = candidates
      .filter((c) => c.prose >= best.prose * 0.98)
      .sort((a, b) => a.fragment.length - b.fragment.length)[0]
    return tight.fragment
  }

  // Nothing container-shaped held prose. Take the paragraphs wherever they are.
  const paras = [...clean.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gi)].map((m) => m[0])
  if (paras.length) return paras.join('\n')
  return clean
}

/**
 * The text the reading view would actually show.
 *
 * Deliberately not "the text in the container". probe_url exists to stop the
 * interface promising things it cannot deliver, so the number it reports has to
 * be measured the same way the renderer measures — otherwise it recommends a
 * reading view for a page like Hacker News, which is four thousand characters
 * of link text and not one paragraph, and the blade opens on a title and
 * nothing else. Same rules, one implementation, no disagreement possible.
 */
export function readableText(body) {
  const parts = []
  let seenProse = false
  const pattern = /<(h1|h2|h3|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi
  let m
  while ((m = pattern.exec(body)) !== null) {
    const tag = m[1].toLowerCase()
    const text = textOf(m[2])
    if (!text) continue
    if (tag === 'li' && !seenProse) continue
    if (tag === 'p' && text.split(/\s+/).length > 8) seenProse = true
    parts.push(text)
  }
  return parts.join(' ')
}
