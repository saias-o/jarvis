/**
 * The `ui_*` tools: JARVIS's control of his own face, on every device.
 *
 * The interface is the same React code on the PC and the phone, so the tools
 * are defined once here. A device supplies one primitive, `ui(op, args)`, that
 * hands an operation to its interface: down the WebSocket on the PC, straight
 * into the store on the phone. The contract is { op, args } with op one of
 * patch, orbit, effect, screen, reset.
 *
 * Each tool has a one-line `description`, which every model reads, and a
 * `guide`: the direction on when a change is worth making. Large models get
 * both; on-device Gemma's small window gets the line.
 *
 * Arguments are forgiving on purpose: '0.5' for 0.5, 1 for true, "auto" for
 * "follow the phase again". A turn that fails because a scale was quoted is a
 * turn the user watched break, so the worst outcome of a bad value is that it
 * is ignored. For that reason these tools normalise their own arguments rather
 * than being refused by strict schema validation.
 *
 * Browser-safe: the phone runs this inside its WebView.
 */

const FALSEY = new Set(['false', '0', 'no', 'off', 'hide', 'hidden', 'none'])
/** Words that mean "stop overriding this and follow the phase again". */
const AUTOMATIC = new Set(['auto', 'default', 'none', 'null', 'reset', 'clear', 'stock'])

function clamp(value, lo, hi) {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) return undefined
  return Math.min(hi, Math.max(lo, n))
}

function toBool(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const s = String(value).trim().toLowerCase()
  if (!s) return undefined
  return !FALSEY.has(s)
}

/** null for "follow the phase", undefined for "not mentioned". */
function toColour(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  const s = String(value).trim()
  if (!s || AUTOMATIC.has(s.toLowerCase())) return null
  return s
}

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
/** Only real values reach the patch, so a deep merge never clears by accident. */
const put = (target, key, value) => { if (value !== undefined) target[key] = value; return target }
const has = (obj) => Object.keys(obj).length > 0
const args = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

/** The store's phases, and what each means on screen: the model picks colours for states it never sees. */
const PHASE_NOTES = {
  offline: 'before the user has unlocked audio',
  boot: 'the startup sequence',
  dormant: 'powered down, waiting for the wake word',
  waking: 'the wake word just landed',
  listening: 'capturing speech',
  thinking: 'you are composing an answer',
  tooling: 'a tool is running',
  speaking: 'you are reading the answer back',
}
export const PHASES = Object.keys(PHASE_NOTES)

const colour = (description) => ({ type: 'string', description })
const number = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })
const object = (properties, required = []) => ({ type: 'object', properties, required })

const THEME_GUIDE = `The HUD is drawn in one colour identity that normally follows your state: cyan
while listening, amber while thinking, violet while a tool runs, green while you
speak. An accent overrides that everywhere, at once.

Use it when the colour MEANS something. Red because a check came back bad.
Amber because you are waiting on something out of your control. A colour pulled
out of an image you just generated, so the room matches the picture. Deep blue
because it is three in the morning and they are still working.

Do not redecorate for the sake of it, and do not leave a strange colour up after
the moment that earned it has passed — call \`ui_reset\` when it is over.

Never announce that you have done it. The user is looking at the screen.

phase_colors recolours single states instead:
${Object.entries(PHASE_NOTES).map(([phase, note]) => `  ${phase} = ${note}`).join('\n')}`

const REACTOR_GUIDE = `The reactor is you. It is the one element the user watches while they wait, so
its size, brightness and speed are read as your state whether you intend them to
be or not. Slowing it and dimming it says the system is idling; brightening and
speeding it says you are working hard on this.

Change one property at a time and mean it. A reactor that is huge, scarlet,
motionless and wireframed all at once is not a state, it is a mess.

Scale below 1 lets the panels dominate; above 1.5 the reactor owns the frame.
Intensity 0.3 reads as standby, 2 or more as strain. Spin 0 reads as powered
down and is worth exactly one dramatic moment; 3 and up reads as effort.
sphere is heavier and more present; wire suits diagnostics and degraded states.
Hide it only when something else has earned the centre of the screen, and put
it back the moment that is over.`

const ORBIT_GUIDE = `This is the interface showing what you have been doing. A render you just
generated, a photograph you were asked about, the screenshot off the phone —
put it in orbit and it lives in the room instead of sitting in a card.

Rules that matter:
  - Only images YOU produced or captured. Absolute path or file:/// URL.
    Anything from the web is refused outright.
  - Three or four objects is a system. Eight is a mess and the frame stops
    reading as anything at all.
  - An orbit persists until you take it down. Clear it when the subject
    changes — a suit render still circling during a conversation about mail is
    just litter.
  - This is not a substitute for a panel. Orbit it when the user should feel
    it; show it when they need to look at it.

Radius 0.3 hugs the reactor, 0.8 sweeps out past the panels. Two to six rpm is
stately; a negative speed counter-rotates. Tilt 20 to 50 sells the depth. Drop
opacity to 0.4 when the object is atmosphere rather than the point. Give a
phase only to oppose two objects deliberately, e.g. 0 and 180.`

const CHROME_GUIDE = `Everything is up by default and that is the right default — the rails are how
the user knows what you are connected to and what you just did.

Hide it only when the absence helps. A photograph they are studying, a single
number they need to hold in their head, a moment you want to land. Strip the
chrome, let the screen be quiet, and put it back when the moment is over. The
user cannot restore it themselves, so leaving it off is taking something from
them.

systems = the SYSTEMS rail, transcript = the conversation log, tool_badge = the
active-tool readout, suggestions = the "try saying" hint, brand = the wordmark
and status line.`

const EFFECT_GUIDE = `  glitch = corruption, interference, something wrong with the data itself.
  pulse  = acknowledgement. Something completed, something arrived.
  scan   = a sweep across the display. Searching, analysing, reading.
  shake  = impact, or a hard stop. The strongest thing here; use it once.
  flash  = a sudden alert. Reserve it for something the user must notice now.

At most one per turn, and only when something actually happened. An effect on
every answer is punctuation, and punctuation stops meaning anything by the third
sentence. Silence on the screen is the default, exactly as it is in your speech.`

const SCREEN_GUIDE = `Use it when the user says clear the screen, or when a topic is finished and the
leftovers from the last one would confuse what comes next.`

const RESET_GUIDE = `Call it when the user asks for normal, and call it yourself when whatever
justified a change is over. It is never the wrong thing to do.`

/** The names of these tools, for adapters that carry them under their own server. */
export const UI_TOOLS = new Set(['ui_theme', 'ui_reactor', 'ui_orbit', 'ui_chrome', 'ui_effect', 'ui_screen', 'ui_reset'])

const GOLDEN_ANGLE = 137.507764

/**
 * @param {(op: string, args: object) => unknown} ui  Hands one operation to the device's interface.
 */
export function uiTools(ui) {
  // Ids arrive in bursts and Date.now() alone collides; the counter also
  // spaces unplaced objects out by the golden angle.
  let seq = 0
  return [
    {
      name: 'ui_theme',
      forgiving: true,
      description: 'Retint the whole interface: accent overrides every phase colour, "auto" gives it back.',
      guide: THEME_GUIDE,
      parameters: object({
        accent: colour('A CSS colour for everything at once, e.g. "#ff2d2d", or "auto".'),
        background: colour('The page colour; keep it near-black, e.g. "#080d18", or "auto".'),
        phase_colors: {
          type: 'object', description: 'Recolour individual states only.',
          // What each state means is in the guide; the names carry it for a small model.
          properties: Object.fromEntries(PHASES.map((p) => [p, { type: 'string' }])),
        },
      }),
      async run(input) {
        const a = args(input)
        const patch = {}
        put(patch, 'accent', toColour(a.accent))
        put(patch, 'background', toColour(a.background))
        const palette = {}
        // A phase colour has no "unset" in the contract: a string or absent.
        for (const [phase, value] of Object.entries(args(a.phase_colors))) {
          const c = toColour(value)
          if (PHASES.includes(phase) && typeof c === 'string') palette[phase] = c
        }
        if (has(palette)) patch.palette = palette
        if (!has(patch)) return 'No change — no colours were given.'
        await ui('patch', patch)
        return 'Interface retinted.'
      },
    },
    {
      name: 'ui_reactor',
      forgiving: true,
      description: 'Reshape the reactor at the centre; omitted properties stay as they are.',
      guide: REACTOR_GUIDE,
      parameters: object({
        color: colour('The reactor core alone, any CSS colour, or "auto".'),
        scale: number('Size, 0.2 to 3, default 1.'),
        intensity: number('Glow, 0 to 3, default 1.'),
        spin: number('Rotation rate, 0 to 5, default 1.'),
        style: { type: 'string', enum: ['ring', 'sphere', 'wire'] },
        visible: bool('false removes the reactor.'),
      }),
      async run(input) {
        const a = args(input)
        const reactor = {}
        put(reactor, 'color', toColour(a.color))
        put(reactor, 'scale', clamp(a.scale, 0.2, 3))
        put(reactor, 'intensity', clamp(a.intensity, 0, 3))
        put(reactor, 'spin', clamp(a.spin, 0, 5))
        put(reactor, 'style', oneOf(a.style, ['ring', 'sphere', 'wire'], undefined))
        put(reactor, 'visible', toBool(a.visible))
        if (!has(reactor)) return 'No change — no reactor properties were given.'
        await ui('patch', { reactor })
        return 'Reactor adjusted.'
      },
    },
    {
      name: 'ui_orbit',
      forgiving: true,
      description: 'Hang an image you produced or captured in orbit around the reactor, or take orbits down.',
      guide: ORBIT_GUIDE,
      parameters: object({
        action: { type: 'string', enum: ['add', 'remove', 'clear'], description: 'Default add.' },
        id: { type: 'string', description: 'Short name, needed to remove.' },
        src: { type: 'string', description: 'Absolute path of an image file.' },
        radius: number('0.1 to 1.2, default 0.55.'),
        speed: number('Revolutions per minute, -30 to 30, default 4.'),
        size: number('Pixels, 16 to 400, default 96.'),
        tilt: number('Degrees, -80 to 80, default 24.'),
        opacity: number('0 to 1, default 0.9.'),
        phase: number('Start angle, degrees.'),
      }),
      async run(input) {
        const a = args(input)
        const action = oneOf(a.action, ['add', 'remove', 'clear'], 'add')
        if (action === 'clear') {
          await ui('orbit', { action: 'clear' })
          return 'Orbits cleared.'
        }
        if (action === 'remove') {
          const id = String(a.id ?? '').trim()
          // Refused rather than guessed: removing "probably the last one" is how
          // an image the user was still looking at disappears.
          if (!id) throw new Error('Not removed: remove needs the id the object was added with. Use action "clear" to take them all down.')
          await ui('orbit', { action: 'remove', id })
          return 'Orbit removed.'
        }
        const src = String(a.src ?? '').trim()
        if (!src) throw new Error('Not added: an orbiting object needs a src, an absolute disk path or a file:/// URL to an image you generated or captured.')
        // The page's content policy would drop it silently, and the model would
        // describe something the user cannot see. The bridge's own /file is the exception.
        if (/^https?:\/\//i.test(src) && !/^http:\/\/localhost:8787\//i.test(src)) {
          throw new Error('Not added: remote images are blocked by the page. Orbit a file you generated, rendered or captured instead.')
        }
        const n = seq++
        // Wrapped rather than clamped: 400 degrees is a sensible thing to mean.
        const angle = clamp(a.phase, -1e6, 1e6)
        const orbit = {
          id: String(a.id ?? '').trim() || `o${Date.now().toString(36)}-${n.toString(36)}`,
          src,
          radius: clamp(a.radius, 0.1, 1.2) ?? 0.55,
          speed: clamp(a.speed, -30, 30) ?? 4,
          size: clamp(a.size, 16, 400) ?? 96,
          tilt: clamp(a.tilt, -80, 80) ?? 24,
          opacity: clamp(a.opacity, 0, 1) ?? 0.9,
          phase: angle === undefined ? (n * GOLDEN_ANGLE) % 360 : ((angle % 360) + 360) % 360,
        }
        await ui('orbit', { action: 'add', ...orbit })
        return `In orbit as "${orbit.id}".`
      },
    },
    {
      name: 'ui_chrome',
      forgiving: true,
      description: 'Show (true) or hide (false) the furniture around the display; put it back when the moment is over.',
      guide: CHROME_GUIDE,
      parameters: object({
        systems: { type: 'boolean' },
        transcript: { type: 'boolean' },
        tool_badge: { type: 'boolean' },
        suggestions: { type: 'boolean' },
        brand: { type: 'boolean' },
      }),
      async run(input) {
        const a = args(input)
        const chrome = {}
        put(chrome, 'systems', toBool(a.systems))
        put(chrome, 'transcript', toBool(a.transcript))
        // Snake case at the tool boundary, camel case in the store.
        put(chrome, 'toolBadge', toBool(a.tool_badge))
        put(chrome, 'suggestions', toBool(a.suggestions))
        put(chrome, 'brand', toBool(a.brand))
        if (!has(chrome)) return 'No change — nothing was named.'
        await ui('patch', { chrome })
        return 'Chrome updated.'
      },
    },
    {
      name: 'ui_effect',
      forgiving: true,
      description: 'Fire one effect across the interface, at most once per turn and only when something happened.',
      guide: EFFECT_GUIDE,
      parameters: object({ kind: { type: 'string', enum: ['glitch', 'pulse', 'scan', 'shake', 'flash'] } }, ['kind']),
      async run(input) {
        await ui('effect', { kind: oneOf(args(input).kind, ['glitch', 'pulse', 'scan', 'shake', 'flash'], 'pulse') })
        return 'Fired.'
      },
    },
    {
      name: 'ui_screen',
      forgiving: true,
      description: 'Clear the display: panels (every card), transcript, or all. Theme, reactor and orbits stay.',
      guide: SCREEN_GUIDE,
      parameters: object({ what: { type: 'string', enum: ['all', 'panels', 'transcript'], description: 'Default all.' } }),
      async run(input) {
        await ui('screen', { what: oneOf(args(input).what, ['all', 'panels', 'transcript'], 'all') })
        return 'Cleared.'
      },
    },
    {
      name: 'ui_reset',
      forgiving: true,
      description: 'Put colours, reactor, orbits and chrome back to stock. Panels and transcript stay.',
      guide: RESET_GUIDE,
      parameters: object({}),
      async run() {
        await ui('reset', {})
        return 'Interface restored.'
      },
    },
  ]
}
