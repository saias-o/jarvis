/**
 * The screen tools: `display` (composed markup), `blade` (a picture, an
 * article, a video, a PDF... on the big surface) and `probe_url`.
 *
 * Defined once for every model and every device. A device supplies `show`,
 * which puts a blade on its interface (the WebSocket on the PC, the store on
 * the phone), and optionally `probe` (what is at a URL, through its own
 * guarded network stack). The browser sanitises markup before rendering it.
 *
 * Each tool has a one-line `description` every model reads, and a `guide`:
 * the design system and the choice of blade, for models with room to read it.
 * Arguments are forgiving like the ui_* tools: a malformed optional value is
 * ignored, a missing required one is refused with a reason the model can act on.
 *
 * Browser-safe: the phone runs this inside its WebView.
 */

const DESIGN_SYSTEM = `
LAYOUT CLASSES — compose these, and use NOTHING else. The renderer strips any
class name that is not on this list, so an invented one silently loses its
styling and the row lands as unformatted text.
  .hud-rows            vertical list container
  .hud-row             one row: put .hud-idx, .hud-main, .hud-tag inside
  .hud-idx             leading index or glyph, dim and monospaced
  .hud-main            the row's text column
  .hud-label           primary line (clamped to 2 lines)
  .hud-sub             secondary line, dimmed
  .hud-tag             small trailing tag, right-aligned
  .hud-metric          huge numeral, for a single headline figure
  .hud-unit            small caption under a metric
  .hud-note            a short passage of prose
  .hud-img             full-width image (use a plain <img> inside)
  .hud-caption         one line under an image
  .hud-grid            two-column grid
  .hud-bar             thin progress bar; set style="--v:0.62" for 62%
  .hud-dim             de-emphasise anything
  .hud-hot             emphasise anything (picks up the accent colour)
  .hud-gallery         grid container for several images at once
  .hud-thumb           one thumbnail, inside a .hud-gallery or beside a .hud-row
  .hud-video           a <video> player, full width of the panel
  .hud-embed           16:9 wrapper for an <iframe>; put the iframe inside it
  .hud-figure          an image or video with its .hud-caption grouped beneath

PICTURES AND VIDEO — these work. Use them.
  - Images from the web render. Image-search results, article thumbnails,
    photographs, product shots, chart images: paste the URL exactly as the tool
    result gave it and it appears. The bridge fetches every remote image
    server-side and hands the bytes to the display, so hosts that refuse to be
    hotlinked still render — nothing is loaded by the page itself.
  - Images off this machine work the same way: a render you generated, a
    screenshot you took, any file on disk. Give it as file:///absolute/path or
    a bare absolute path.
  - If a search came back with pictures, SHOW the pictures. A row of thumbnails
    down the side of the headlines beats headlines alone, every time — and a
    grid of results is the whole answer to an image search, not a decoration
    on it.
  - Video results are for playing, not describing. A YouTube or Vimeo result
    goes in an <iframe> inside .hud-embed; a direct .mp4 or .webm goes in a
    <video class="hud-video" controls>.
  - Never invent a URL. Use only ones that appeared verbatim in a tool result.
    A guessed address is a broken image, and a broken image is worse than none.

WHERE THE CONTENT COMES FROM — read this before showing anything from the web.
  - Fetch with exa. crawling_exa and web_fetch_exa return the page's actual
    text and its image URLs; deep_search_exa and web_search_advanced_exa
    return content alongside the results. That returned content is what you
    render — rewritten into these classes, in your own words and this interface's
    shape. You are not linking to an article, you are showing it.
  - Do NOT put a bare source URL on screen and leave the page to fetch it for
    itself. Half the web refuses that: news CDNs answer 403 to anything that
    is not their own page, and the panel renders as an empty rectangle. Going
    through exa is what makes the difference between an article appearing and a
    blank card.
  - So: asked about a page, crawl it, then panel the substance — the headline,
    the two or three lines that matter, the figure, the photograph.
  - Image URLs that came back IN a tool result are real and will render; the
    bridge fetches them server-side. An image URL you inferred or assembled
    yourself will not. Never guess one.

RULES
  - No inline colours. The accent is themed by the 'accent' argument; use the
    classes and it follows automatically.
  - No <style>, <script>, <form>, or event handlers. They are stripped.
  - <iframe> is allowed for exactly three hosts: www.youtube-nocookie.com/embed,
    www.youtube.com/embed and player.vimeo.com/video. Any other src and the
    whole element is removed. A youtube.com/watch?v=ID or youtu.be/ID link is
    fine to paste — it is rewritten into the embed form for you.
  - Every panel must have visible text or a working image. An empty body is
    rejected outright — a blank card reads as a broken interface.
  - Keep it to roughly 6 rows or 40 words. This is a heads-up display glanced at
    while listening, not a document. Four thumbnails in a gallery, six at the
    outside; one video, never two.

EXAMPLES

Search results:
<div class="hud-rows">
  <div class="hud-row"><span class="hud-idx">01</span><span class="hud-main"><span class="hud-label">Anthropic ships Claude Opus 5</span><span class="hud-sub">A step change on agentic coding</span></span><span class="hud-tag">reuters</span></div>
  <div class="hud-row"><span class="hud-idx">02</span><span class="hud-main"><span class="hud-label">OpenAI responds within the week</span></span><span class="hud-tag">verge</span></div>
</div>

A single figure:
<div><span class="hud-metric">1,284</span><span class="hud-unit">unread since monday</span></div>

An image:
<div><img class="hud-img" src="file:///Users/you/shot.png"><span class="hud-caption">Home screen, 9:41</span></div>

Image search results — the pictures ARE the answer, so lead with them:
<div class="hud-figure">
  <div class="hud-gallery">
    <img class="hud-thumb" src="https://images.example.com/sr71-01.jpg">
    <img class="hud-thumb" src="https://cdn.example.org/blackbird-takeoff.jpg">
    <img class="hud-thumb" src="https://static.example.net/sr71-cockpit.jpg">
    <img class="hud-thumb" src="https://images.example.com/sr71-hangar.jpg">
  </div>
  <span class="hud-caption">SR-71 Blackbird · four of two hundred results</span>
</div>

Headlines with their thumbnails:
<div class="hud-rows">
  <div class="hud-row"><img class="hud-thumb" src="https://cdn.example.com/launch.jpg"><span class="hud-main"><span class="hud-label">Starship clears the tower on the eleventh flight</span><span class="hud-sub">Booster caught, ship lost on re-entry</span></span><span class="hud-tag">reuters</span></div>
  <div class="hud-row"><img class="hud-thumb" src="https://cdn.example.org/pad.jpg"><span class="hud-main"><span class="hud-label">Pad damage limited to the flame trench</span></span><span class="hud-tag">ars</span></div>
</div>

A video result — embedded and playable:
<div class="hud-figure">
  <div class="hud-embed"><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="Flight 11, full replay" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>
  <span class="hud-caption">SpaceX · 4:32</span>
</div>

A direct video file:
<video class="hud-video" controls playsinline preload="metadata" poster="https://cdn.example.com/still.jpg"><source src="https://cdn.example.com/clip.mp4" type="video/mp4"></video>

A short readout:
<p class="hud-note">Three of the four services are nominal. <span class="hud-hot">Vercel is degraded</span> in eu-west.</p>
`.trim()

const DISPLAY_GUIDE = `Put something on the JARVIS heads-up display.

You are designing the panel, not filling in a template — compose the markup for
the content at hand and choose the animation, position and colour that suit it.

Use it whenever the answer has substance worth seeing rather than hearing:
search results, images, screenshots, lists of mail or events, a figure, a short
readout. If you searched, show the results. If you generated an image, show it.
If you looked at the phone, show the screenshot.

If the search came back with pictures, show the pictures — thumbnails from the
web render properly here, and describing an image you are holding the URL of is
a worse answer than putting it on the screen. If it came back with a video,
embed it so it plays.

Call it BEFORE or WHILE you speak, so the panel is up as you start talking.
Never read a panel aloud — say what it means, not what it contains. Speaking
stays one or two sentences even when the panel is dense.

${DESIGN_SYSTEM}`

const BLADE_GUIDE = `Open something on the blades — the big surface.

A panel is a card you glance at. A blade is a thing you LOOK at: a photograph
worth seeing properly, an article worth reading, a video worth watching. Blades
stack, the newest in front, and the user can pull an older one forward or throw
one to full screen. Use a blade whenever the content deserves the frame, and a
panel when it deserves a line.

Choosing what to open:
  article — a web page. \`mode: "reader"\` strips it to the words and restyles
            them into this interface: always legible, ignores whether the site
            allows being embedded. \`mode: "live"\` shows the real page, which is
            right when the layout carries meaning — a dashboard, a profile, a
            table, a chart. Both are fetched by the bridge and served locally,
            so sites that block embedding still open.
  image   — one picture, full width of the blade.
  gallery — several pictures at once. This is the answer to an image search.
  video   — a direct .mp4/.webm file.
  embed   — a YouTube or Vimeo watch URL, for something to WATCH: it fills a
            blade and closes when the user next speaks. Anything to LISTEN to,
            or that they may want to skip, pause or wind forward, belongs in
            \`play_music\` instead — that player is small, it stays between
            turns, and it is the only one you can drive afterwards.
  pdf     — a PDF document, shown page by page in a real PDF viewer. For a file
            in the user's Google Drive, pass its Drive link (or its file id)
            straight from the Drive search result — do NOT download it first,
            the viewer fetches it itself. For a PDF on the web, pass its URL.
            Use this whenever they ask to see, open or show a PDF; reading its
            text yourself is for answering questions about it, not for showing it.
  markup  — your own composed HTML, in the same .hud-* system the display tool
            uses, when none of the above is the shape of the answer.
  camera  — the live view from the user's camera, on screen. Open it when they
            ask to see the camera, or when they want you to watch them do
            something: while it is open you can also review the seconds that
            have just passed, which you cannot do otherwise. Needs no url.

Size is about reading, not decoration. \`tall\` is a reading column — use it for
any article the user intends to actually read. \`wide\` suits images, video and
tables. \`full\` takes the screen and should be reserved for the moment the
content IS the answer. \`compact\` is a thumbnail that stays out of the way.

Call \`probe_url\` first when you are not certain what a URL is. Do not guess
from the file extension — image CDNs routinely serve pictures from URLs with no
extension, and a link that looks like a video is usually a page about one.

Never open a blade the user did not ask for and does not need. One blade that
answers the question beats three that surround it.`

const PROBE_GUIDE = `Find out what is actually at a URL before showing it.

Returns what it is, whether it can be reached at all, and — for a web page —
its title, how much readable prose it holds, and a lead image if it has one.

Worth calling whenever you are about to put something on screen and are not
certain of it. The failure this avoids is the visible kind: a blade that opens
onto a blank rectangle because the link was a consent wall, or an image that
turns out to be an HTML page, in front of the user, while you describe it as
though it worked.

It reports a \`suggestion\`. That is advice from something that has only seen
the bytes — it does not know whether the user asked to read this or merely to
see it, what is already on screen, or whether the point was the picture or the
argument. You know those things. Overrule it whenever you have reason to.`

/** The names of these tools, for adapters that carry them under their own server. */
export const DISPLAY_TOOLS = new Set(['display', 'blade', 'probe_url'])

const KINDS = ['article', 'image', 'gallery', 'video', 'embed', 'pdf', 'markup', 'camera']
const CAMERA_BLADE = /  camera  — the live view from the user's camera[\s\S]*?Needs no url\.\n/
const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
const args = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const text = (value) => String(value ?? '').trim()

/**
 * @param {{ show: (blade: object) => unknown, probe?: (url: string, options?: { signal?: AbortSignal }) => Promise<object>, camera?: boolean }} platform
 *   camera: whether a blade may open the live camera view on this device.
 */
export function displayTools({ show, probe, camera = false }) {
  // Blade ids are React keys and arrive in bursts: Date.now() alone collides.
  let seq = 0
  const id = (prefix) => `${prefix}${Date.now().toString(36)}-${(seq++).toString(36)}`
  const kinds = camera ? KINDS : KINDS.filter((kind) => kind !== 'camera')
  const tools = [
    {
      name: 'display',
      forgiving: true,
      description: 'Put a panel of your own HTML on the screen, composed with the .hud-* classes (hud-rows, hud-row, hud-label, hud-sub, hud-metric, hud-note, hud-img, hud-gallery).',
      guide: DISPLAY_GUIDE,
      parameters: {
        type: 'object', required: ['title', 'html'],
        properties: {
          title: { type: 'string', description: 'Two to four words.' },
          html: { type: 'string', description: 'The panel body.' },
          slot: { type: 'string', enum: ['right', 'left', 'wide'], description: 'wide for images or tables.' },
          hold: { type: 'string', enum: ['turn', 'sticky'], description: 'sticky stays until replaced.' },
        },
      },
      async run(input) {
        const a = args(input)
        const html = String(a.html ?? '')
        // Refused rather than shown: a blank card reads as a broken interface
        // and an error gives the model one more go with real content. Media
        // count as content: a playable result carries no text at all.
        if (!html.replace(/<[^>]*>/g, '').trim() && !/<(img|video|iframe|source)\b/i.test(html)) {
          throw new Error('Not shown: the panel body was empty. A panel needs visible text or an image; call display again with the content composed into html.')
        }
        // Composed markup opens as a blade: there is one surface to look at.
        await show({ id: id('p'), title: text(a.title) || 'DISPLAY', kind: 'markup', html,
          size: a.slot === 'wide' ? 'wide' : 'compact', hold: oneOf(a.hold, ['turn', 'sticky'], 'turn') })
        return 'On screen.'
      },
    },
    {
      name: 'blade',
      forgiving: true,
      description: `Open something on the big surface: ${kinds.join(', ')}. url for article, image, video, embed and pdf; images for a gallery; html for markup.`,
      guide: camera ? BLADE_GUIDE : BLADE_GUIDE.replace(CAMERA_BLADE, ''),
      parameters: {
        type: 'object', required: ['title', 'kind'],
        properties: {
          title: { type: 'string', description: 'Two to four words.' },
          kind: { type: 'string', enum: kinds },
          url: { type: 'string', description: 'An address that appeared in a tool result.' },
          images: { type: 'array', items: { type: 'string' }, description: 'Up to eight image addresses.' },
          html: { type: 'string' },
          mode: { type: 'string', enum: ['reader', 'live'], description: 'For an article.' },
          size: { type: 'string', enum: ['compact', 'tall', 'wide', 'full'] },
          hold: { type: 'string', enum: ['turn', 'sticky'] },
        },
      },
      async run(input) {
        const a = args(input)
        const kind = a.kind
        if (!kinds.includes(kind)) throw new Error(`Not opened: kind must be one of ${kinds.join(', ')}.`)
        const url = text(a.url)
        const images = Array.isArray(a.images) ? a.images.map(text).filter(Boolean) : []
        // Refused rather than emitted: a blade that opens onto nothing looks
        // like the interface failing, and the model gets no signal to retry.
        if (kind === 'gallery' && !images.length) throw new Error('Not opened: a gallery needs at least one image URL in `images`.')
        if (kind === 'markup' && !text(a.html)) throw new Error('Not opened: kind "markup" needs an `html` body.')
        if (['article', 'image', 'video', 'embed', 'pdf'].includes(kind) && !url) throw new Error(`Not opened: kind "${kind}" needs a \`url\`.`)
        const blade = {
          id: id('b'),
          title: text(a.title) || 'DISPLAY',
          kind,
          url: url || undefined,
          images: images.length ? images.slice(0, 8) : undefined,
          html: a.html || undefined,
          mode: oneOf(a.mode, ['reader', 'live'], 'reader'),
          // A reading column for anything meant to be read, a broad frame for
          // anything meant to be looked at.
          size: oneOf(a.size, ['compact', 'tall', 'wide', 'full'], kind === 'article' || kind === 'pdf' ? 'tall' : 'wide'),
          hold: oneOf(a.hold, ['turn', 'sticky'], 'turn'),
        }
        await show(blade)
        return `Open on the blades as "${blade.title}".`
      },
    },
  ]
  if (probe) {
    tools.push({
      name: 'probe_url',
      description: 'Find out what is at a URL (type, reachability, title, lead image) before showing it.',
      guide: PROBE_GUIDE,
      parameters: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'The absolute URL.' } } },
      run: async ({ url }, { signal } = {}) => JSON.stringify(await probe(String(url ?? ''), { signal }), null, 1),
    })
  }
  return tools
}
