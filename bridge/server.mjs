/**
 * JARVIS local bridge.
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and exposes one turn
 * of conversation over a WebSocket. The browser stays the face and the voice;
 * this process is the brain and the hands.
 *
 * Two things this buys over calling the Claude API from the browser:
 *   1. No API key. It authenticates exactly the way `claude` does, off your
 *      existing login, and bills to that same account.
 *   2. Every MCP server in your Claude Code config is available, including the
 *      local stdio ones a browser could never reach — higgsfield, elevenlabs,
 *      android, playwright, palmier-pro and the rest.
 *
 *   node bridge/server.mjs
 */

import { WebSocketServer } from 'ws'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createInference } from './inference.mjs'
import { pcTools } from './pc-tools.mjs'
import { chromeAvailable, chromeTools } from './chrome.mjs'
import { MEMORY_FILE } from './memory.mjs'
import { createRemote, REMOTE_FILE } from './remote.mjs'
import { brainMode, createHealth, createProbe } from './router.mjs'
import { createLocal, localConfig } from './local.mjs'
import { fileTrace } from './trace.mjs'
import { createTrace } from '../shared/trace.mjs'
import { createInbox } from './inbox.mjs'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deviceRoutes } from './routes/device.mjs'
import { mediaRoutes } from './routes/media.mjs'
import { elevenKey, voiceRoutes } from './routes/voice.mjs'
import { UNHANDLED } from './routes/unhandled.mjs'
import { createSession } from './session.mjs'
import { LANGUAGE, systemPrompt } from './prompt.mjs'
import {
  checkToolUse,
  decideTool as decidePolicy,
  fetchTargetProblem,
  fileRoots,
} from './policy.mjs'

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)

/**
 * Which interface to listen on. Loopback, unless you say otherwise.
 *
 * `server.listen(PORT)` with no host binds every interface, which puts the
 * agent socket, the file endpoint and both proxies on the local network. The
 * Origin check below does not save that: it keeps other *browser tabs* out, but
 * any other machine on the LAN is free to send whatever Origin header it likes.
 * On WSL2 with mirrored networking, and on any machine that forwards ports, a
 * wildcard bind is reachable from the office or café network directly.
 *
 * 127.0.0.1 rather than 'localhost' because the name can resolve to ::1 alone,
 * and IPv6 loopback is not forwarded between Windows and WSL — a browser on the
 * Windows side would then find nothing listening.
 */
// Blank counts as unset: listen(PORT, '') binds every interface, which is the
// one outcome this default exists to prevent.
const HOST = process.env.JARVIS_BRIDGE_HOST?.trim() || '127.0.0.1'

/**
 * Remote access — a phone, or any second device — on a port of its own.
 *
 * Off unless JARVIS_REMOTE_PORT is set (`npm run remote` sets it). The port
 * above keeps its rules exactly as they are; this one always listens on
 * loopback, serves the built interface, and refuses everything that does not
 * carry the access cookie. Something else carries it off the machine, and
 * JARVIS_REMOTE_HOSTS names what that something calls it. See remote.mjs.
 */
const REMOTE_PORT = process.env.JARVIS_REMOTE_PORT?.trim()
  ? Number(process.env.JARVIS_REMOTE_PORT)
  : null
const REMOTE =
  REMOTE_PORT === null
    ? null
    : createRemote({
        hosts: (process.env.JARVIS_REMOTE_HOSTS ?? '').split(','),
        // The access code is on unless switched off by name; a typo must not
        // be what removes a lock.
        requireCode: !['off', '0', 'false', 'no'].includes(
          (process.env.JARVIS_REMOTE_CODE ?? '').trim().toLowerCase(),
        ),
        users: (process.env.JARVIS_REMOTE_USERS ?? '').split(','),
        origins: (process.env.JARVIS_REMOTE_ORIGINS ?? '').split(','),
        faceDir:
          process.env.JARVIS_FACE_DIR?.trim() ||
          fileURLToPath(new URL('../dist', import.meta.url)),
      })

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection:', err)
})

/**
 * Who is allowed to talk to this bridge.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it on behalf of whatever page asked, no preflight stands in the way,
 * and the page reads every byte that comes back. Without a check here, any tab
 * the user happens to have open could open a socket to ws://localhost:8787,
 * drive the agent with every MCP server on this machine, and read back every
 * token and panel. The Origin header is the only thing that separates our own
 * dev server from someone else's page, so it is checked explicitly.
 *
 * A missing Origin means a non-browser client — curl, a script, a native app.
 * That is also exactly what local malware looks like, so it is refused on the
 * socket unless JARVIS_ALLOW_NO_ORIGIN=1 says otherwise.
 */
const EXTRA_ORIGINS = new Set(
  (process.env.JARVIS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const ALLOW_NO_ORIGIN = process.env.JARVIS_ALLOW_NO_ORIGIN === '1'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Vite takes the next free port when 5173 is busy and `vite preview` starts at
 * 4173, so the dev ranges are allowed rather than two exact numbers. Anything
 * else — including localhost on a port some other app is serving — has to be
 * named in JARVIS_ALLOWED_ORIGINS.
 */
const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

function originAllowed(origin) {
  if (!origin) return ALLOW_NO_ORIGIN
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (!LOCAL_HOSTS.has(url.hostname)) return false
  return isDevPort(Number(url.port))
}

/**
 * Which Host header a request must carry.
 *
 * The Origin check has one gap, and it is DNS rebinding. A page on
 * attacker.example can re-point its own name at 127.0.0.1 and then fetch
 * `http://attacker.example:8787/file?...` — a same-origin GET, which carries no
 * Origin header at all and so sails through the `!origin` branch above. What
 * it cannot forge is the Host header: the browser sends the name it thinks it
 * is talking to. So anything addressed to a name other than loopback is
 * refused before it is routed.
 *
 * JARVIS_ALLOWED_HOSTS names extra hostnames, for anyone who deliberately
 * serves the bridge under another name.
 */
const EXTRA_HOSTS = new Set(
  (process.env.JARVIS_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)

function hostAllowed(host) {
  if (typeof host !== 'string' || !host) return false
  let name
  try {
    name = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  return LOCAL_HOSTS.has(name) || EXTRA_HOSTS.has(name)
}

/**
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 *
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world waits for JARVIS_ALLOW_WRITES=1 (or the
 * --writes flag, which `npm run bridge:writes` passes — a flag works in every
 * shell, where an inline env assignment does not run on Windows). Start
 * without it, and turn it on once you trust what you're demoing.
 */
const ALLOW_WRITES =
  process.env.JARVIS_ALLOW_WRITES === '1' || process.argv.includes('--writes')

/**
 * Built-in capabilities to leave out entirely: `browser` (the user's own
 * Chrome), `camera`, `interface` (the ui_* tools). A capability left out is
 * not merely denied — its tools never reach the model, which also saves their
 * schemas on every turn (about 3,100, 1,400 and 4,800 input tokens
 * respectively). The display itself is always on; it is how JARVIS shows
 * anything.
 */
const DISABLED = new Set(
  (process.env.JARVIS_DISABLE ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)

/**
 * The orchestrator model. Override with JARVIS_MODEL to trade quality for pace
 * — claude-sonnet-5 is noticeably snappier on camera if Opus feels slow.
 */
const MODEL = process.env.JARVIS_MODEL ?? 'claude-opus-5'

/**
 * How hard the model thinks before answering.
 *
 * This was 'low', on the reasoning that a voice assistant is judged on latency
 * — and that is true right up until the answer is thin. Low effort scopes the
 * work tightly to what was literally asked: fewer tool calls, less
 * cross-referencing, no second look. On a model of this tier that is leaving
 * most of it on the table.
 *
 * 'medium' is the compromise worth having here. It reasons and reaches for
 * tools noticeably more than 'low' while still answering inside the window a
 * spoken conversation tolerates. Raise it to 'high' or 'xhigh' when quality
 * matters more than pace; drop back to 'low' when filming and every second of
 * dead air shows.
 */
const EFFORT = process.env.JARVIS_EFFORT ?? 'high'

/**
 * The second brain, and when it answers.
 *
 * Claude Code is the brain; a small model on this machine (Ollama, see
 * local.mjs) stands in when Claude cannot answer — no network, a usage limit,
 * a lapsed login, the service itself down. JARVIS_BRAIN picks the rule:
 * `auto` (the default) falls back and comes back by itself, `claude` never
 * falls back, `local` never leaves the machine. With no Ollama installed
 * `auto` behaves exactly as the bridge always has.
 */
const BRAIN_MODE = brainMode(process.env.JARVIS_BRAIN)
const LOCAL = createLocal(localConfig())
const LOCAL_SHELL = process.env.JARVIS_LOCAL_SHELL !== '0'
const CLAUDE_HEALTH = createHealth()
const claudeReachable = createProbe()
/** When the usage limit lifts, as last reported by the API. */

/** Failed attempts the CLI may make on one request before the local model takes it. */
const RETRY_PATIENCE = 2

/**
 * Every MCP server Claude Code has configured, read out of its own config.
 *
 * This does two jobs. The HUD wants the names while the boot animation plays,
 * and the agent doesn't emit its init message — and therefore its server
 * list — until the first user message flows through, which is far too late.
 * More importantly, this bridge turns filesystem settings off (see
 * settingSources below) and the SDK stops discovering these servers on its
 * own, so handing them over explicitly is what keeps the local stdio ones —
 * the whole reason the bridge exists — in play.
 *
 * Only the global block and the home-directory project scope — the scope
 * `claude` itself applies when run from home, which is where these servers
 * have always been picked up from. That makes the list a close but not exact match for
 * the agent's own: the 'ready' sent on connect comes from here and the second
 * one, sent from the init message a turn later, carries live status. Expect
 * the two to differ, and treat the later one as authoritative.
 */
function configuredServers() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return {
      ...(cfg.mcpServers ?? {}),
      // Servers scoped to the home directory apply too, since that's our cwd.
      ...(cfg.projects?.[homedir()]?.mcpServers ?? {}),
    }
  } catch {
    return {}
  }
}

/**
 * Which of those JARVIS actually gets.
 *
 * Every server in your Claude Code config is a server a voice agent that reads
 * the open web can be talked into calling, so "all of them" is a poor default
 * for anyone whose config has grown. JARVIS_MCP_SERVERS names the ones to hand
 * over, comma separated; unset keeps the old behaviour of passing everything
 * configured, and an empty value passes none.
 */
function allowedServers(all, list) {
  if (list === undefined) return all
  const wanted = new Set(
    list
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return Object.fromEntries(Object.entries(all).filter(([name]) => wanted.has(name)))
}

const MCP_SERVERS = allowedServers(configuredServers(), process.env.JARVIS_MCP_SERVERS)

/**
 * Account connectors — the mail, drive, calendar and other integrations
 * attached to your claude.ai account — are not in ~/.claude.json and are not
 * affected by settingSources. The CLI fetches them itself and they join the
 * session from the second turn on, which is why the HUD's server count jumps
 * after the first question. Measured on SDK 0.3.220: mail, drive, calendar
 * and other account connectors all arrived that way, with their read tools
 * running in read-only mode and their send, share and delete tools one
 * JARVIS_ALLOW_WRITES away.
 *
 * strictMcpConfig limits the session to the servers passed below. Set
 * JARVIS_ACCOUNT_CONNECTORS=1 to let the account's connectors in as well.
 */
const ACCOUNT_CONNECTORS = process.env.JARVIS_ACCOUNT_CONNECTORS === '1'

/**
 * The tool policy lives in policy.mjs so it can be tested on its own. Bound to
 * this process's write setting once, so everything below reads as before.
 */
const decideTool = (name) => decidePolicy(name, ALLOW_WRITES)

/**
 * The agent's working directory, and the only folder its file tools may use
 * besides the temp directory and JARVIS_FILE_ROOTS.
 *
 * This used to be the home directory, which made every file under it — SSH
 * keys, the Claude login, other projects' .env files — fair game for a Read,
 * and the CLI approves reads inside its working directory without asking
 * anyone. A dedicated folder keeps "what can a web page talk JARVIS into
 * reading" down to what JARVIS itself put there.
 */
const WORKSPACE = resolvePath(
  process.env.JARVIS_WORKSPACE ?? join(homedir(), '.jarvis', 'workspace'),
)
mkdirSync(WORKSPACE, { recursive: true })
const TRACE_DIR = resolvePath(process.env.JARVIS_TRACE_DIR || join(WORKSPACE, '..', 'logs'))
const TRACE = process.env.JARVIS_TRACE === '0' ? createTrace({ write: () => {} }) : fileTrace(TRACE_DIR)
void TRACE.record('service.start', { pid: process.pid, model: MODEL, mode: BRAIN_MODE, workspace: WORKSPACE })
console.log(`[jarvis] structured traces ${process.env.JARVIS_TRACE === '0' ? 'disabled' : `in ${TRACE_DIR}`}`)

/**
 * Print each question and each finished answer in the bridge's terminal.
 *
 * Off by default, like the transcripts: what is said to an assistant is not
 * something to write down unasked. But "he told me he couldn't" cannot be
 * diagnosed from a log that holds only tool names, and JARVIS_DEBUG answers it
 * with every stream event of every turn. This is the middle: two lines a turn,
 * in the terminal only, never on disk.
 */
const LOG_TALK = process.env.JARVIS_LOG_TALK === '1'
const said = (text) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > 700 ? `${flat.slice(0, 700)}…` : flat
}

/** The user's own folders, shared on purpose with JARVIS_FILE_ROOTS. */
const SHARED_ROOTS = (process.env.JARVIS_FILE_ROOTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/**
 * Where a file handed to JARVIS lands (see inbox.mjs). Inside the workspace by
 * default, so the file tools reach it with no further permission.
 */
const INBOX = createInbox(
  resolvePath(process.env.JARVIS_INBOX?.trim() || join(WORKSPACE, 'inbox')),
  { maxBytes: (Number(process.env.JARVIS_UPLOAD_MAX_MB) || 1024) * 1024 * 1024 },
)
mkdirSync(INBOX.dir, { recursive: true })

const TOOL_ROOTS = fileRoots({ workspace: WORKSPACE, extra: [...SHARED_ROOTS, INBOX.dir] })

/**
 * The enforcement point. A PreToolUse hook runs before every tool call,
 * including the ones the CLI would otherwise approve on its own without
 * consulting canUseTool — see policy.mjs for the measurement.
 */
const enforcePolicy = async (input) => {
  const verdict = checkToolUse(input.tool_name, input.tool_input, {
    allowWrites: ALLOW_WRITES,
    cwd: WORKSPACE,
    roots: TOOL_ROOTS,
  })
  let reason = verdict.allow ? null : verdict.reason
  if (!reason && input.tool_name === 'WebFetch') {
    const problem = await fetchTargetProblem(input.tool_input?.url)
    if (problem) reason = `Blocked: that address cannot be fetched (${problem}).`
  }
  if (!reason) return {}
  console.log(`[jarvis] tool ${input.tool_name} -> deny (policy)`)
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

const SYSTEM_PROMPT = systemPrompt({ ALLOW_WRITES, DISABLED, INBOX, SHARED_ROOTS })

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

/** The endpoints below; on the remote port, each one needs the access cookie. */
const API_PATHS = new Set(['/pc-tools', '/inference', '/health', '/file', '/img', '/media', '/pdf', '/page', '/tts', '/stt', '/upload'])

/**
 * Everything the remote port decides before a request reaches a handler:
 * whether to answer at all, the code-for-cookie exchange, the access check,
 * and the built interface. Resolves true when it has already responded.
 */
async function remoteGate(req, res) {
  if (!REMOTE.hostAllowed(req) || !REMOTE.originAllowed(req) || !REMOTE.userAllowed(req)) {
    console.warn(
      `[jarvis] refused remote request for host ${req.headers.host ?? '(none)'}` +
        (req.headers.origin ? ` from origin ${req.headers.origin}` : '') +
        (REMOTE.userAllowed(req) ? '' : ' (not the Tailscale account of the owner)'),
    )
    res.writeHead(403)
    res.end('forbidden')
    return true
  }
  const cors = REMOTE.cors(req)
  for (const [name, value] of Object.entries(cors)) res.setHeader(name, value)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true }
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const json = (status, body, extra = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra })
    res.end(JSON.stringify(body))
    return true
  }

  if (path === '/auth') {
    if (req.method === 'GET') {
      return json(200, { required: REMOTE.requireCode, ok: REMOTE.authed(req) })
    }
    if (req.method !== 'POST') return json(405, { ok: false })
    if (!REMOTE.requireCode) return json(200, { ok: true })
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 1024) {
        req.destroy()
        return json(400, { ok: false })
      }
    }
    let code = ''
    try {
      code = JSON.parse(body || '{}').code ?? ''
    } catch {
      return json(400, { ok: false })
    }
    const verdict = REMOTE.tryCode(code)
    if (verdict === 'ok') {
      console.log('[jarvis] remote device paired')
      return json(200, { ok: true, token: REMOTE.appToken(req) }, { 'set-cookie': REMOTE.cookieHeader(req) })
    }
    console.warn(`[jarvis] remote access code refused (${verdict})`)
    return json(verdict === 'locked' ? 429 : 401, { ok: false, locked: verdict === 'locked' })
  }

  if (API_PATHS.has(path)) {
    if (REMOTE.authed(req) || REMOTE.imageSigned(req)) return false
    res.writeHead(401, { 'cache-control': 'no-store' })
    res.end('access code required')
    return true
  }

  if (await REMOTE.serveFace(req, res)) return true
  res.writeHead(404)
  res.end()
  return true
}

/** The user's Chrome, built once: its tab state belongs to the browser, not to a connection. */
const BROWSER_TOOLS = DISABLED.has('browser') ? [] : chromeTools({ allowWrites: ALLOW_WRITES })
const androidPcTools = pcTools({ allowWrites: ALLOW_WRITES, shell: LOCAL_SHELL, cwd: WORKSPACE, roots: TOOL_ROOTS, extra: BROWSER_TOOLS })
const inferAndroid = createInference({ query, model: MODEL, effort: EFFORT, cwd: WORKSPACE, executable: process.env.JARVIS_CLAUDE_EXECUTABLE, host: androidPcTools.manifest })
/** Each group answers its own paths and returns UNHANDLED for the others. */
const ROUTES = [
  deviceRoutes({ TRACE, androidPcTools, inferAndroid, INBOX, BRAIN_MODE, CLAUDE_HEALTH, LOCAL }),
  mediaRoutes({ WORKSPACE, INBOX, TRACE, REMOTE, PORT }),
  voiceRoutes(),
]

const handleRequest = async (req, res, viaRemote = false) => {
  if (viaRemote) {
    if (await remoteGate(req, res)) return
  } else {
    if (!hostAllowed(req.headers.host)) {
      console.warn(`[jarvis] refused http request for host ${req.headers.host ?? '(none)'}`)
      res.writeHead(403)
      return res.end('forbidden')
    }
    const origin = req.headers.origin
    if (origin && !originAllowed(origin)) {
      console.warn(`[jarvis] refused http request from origin ${origin}`)
      res.writeHead(403, { vary: 'origin' })
      return res.end('forbidden')
    }
  }
  // The remote page is served from this same origin, so it needs no CORS.
  const cors = viaRemote ? REMOTE.cors(req) : corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  for (const route of ROUTES) {
    if ((await route(req, res, cors, viaRemote)) !== UNHANDLED) return
  }

  res.writeHead(404, cors)
  res.end()
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[jarvis] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') {
      console.warn(`[jarvis] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!hostAllowed(req.headers.host)) {
      console.warn(`[jarvis] rejected websocket for host ${req.headers.host ?? '(none)'}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[jarvis] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set JARVIS_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
// A port someone else holds is the commonest reason the bridge won't start, and
// Node's default is an unhandled 'error' event and a stack trace. Say it plainly
// and exit non-zero, so a launcher knows the brain never came up.
server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `[jarvis] port ${PORT} on ${HOST} is already in use — stop whatever holds it or set JARVIS_BRIDGE_PORT`
      : `[jarvis] bridge could not listen on ${HOST}:${PORT}: ${err.message}`,
  )
  process.exit(1)
})
await new Promise((resolve) => server.listen(PORT, HOST, resolve))

const LOOPBACK = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost'
const bound = server.address()
console.log(
  `[jarvis] bridge listening on ws://${bound.family === 'IPv6' ? `[${bound.address}]` : bound.address}:${bound.port}`,
)
if (!LOOPBACK) {
  console.warn(
    `[jarvis] WARNING: listening on ${HOST}, not loopback — other machines on this network can reach the bridge`,
  )
}
console.log(
  `[jarvis] speech ${elevenKey() ? 'via ElevenLabs (key from MCP config)' : 'using browser fallback voice'}`,
)
console.log(`[jarvis] model ${MODEL} · effort ${EFFORT}`)
// Asynchronous: Ollama is asked whether it has the model. Said either way,
// because "the fallback never kicked in" has to be answerable from this log.
if (BRAIN_MODE !== 'claude') {
  void LOCAL.problem().then((problem) => {
    console.log(
      problem
        ? `[jarvis] local model unavailable — ${problem}` +
            (BRAIN_MODE === 'auto' ? ' (Claude only until it is)' : '')
        : `[jarvis] local model ${LOCAL.model} ready` +
            (BRAIN_MODE === 'auto' ? ' — takes over when Claude cannot answer' : ' — answering everything (JARVIS_BRAIN=local)'),
    )
  })
}
console.log(`[jarvis] memory in ${MEMORY_FILE}`)
console.log(`[jarvis] dropped files in ${INBOX.dir}`)

/**
 * The remote port: the same handlers and the same agent, behind the gate.
 * Always loopback, whatever JARVIS_BRIDGE_HOST says — it is reached through a
 * proxy on this machine, never directly.
 */
let remoteWss = null
if (REMOTE) {
  const remoteServer = http.createServer((req, res) => {
    handleRequest(req, res, true).catch((err) => {
      console.error('[jarvis] remote request failed:', err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  remoteWss = new WebSocketServer({
    server: remoteServer,
    verifyClient: ({ origin, req }, done) => {
      const path = (req.url ?? '/').split('?')[0]
      if (path !== '/' && path !== '/ws') return done(false, 403, 'Forbidden')
      // A browser always sends Origin on a socket, so one without it is not
      // the interface — and here, unlike an <img>, there is no reason to be.
      if (
        !origin ||
        !REMOTE.hostAllowed(req) ||
        !REMOTE.originAllowed(req, origin) ||
        !REMOTE.userAllowed(req)
      ) {
        console.warn(
          `[jarvis] rejected remote websocket for host ${req.headers.host ?? '(none)'} from origin ${origin ?? '(none)'}`,
        )
        return done(false, 403, 'Forbidden')
      }
      if (!REMOTE.authed(req)) return done(false, 401, 'Unauthorized')
      done(true)
    },
  })
  remoteServer.on('error', (err) => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `[jarvis] remote port ${REMOTE_PORT} is already in use — set JARVIS_REMOTE_PORT`
        : `[jarvis] remote access could not listen on port ${REMOTE_PORT}: ${err.message}`,
    )
    process.exit(1)
  })
  await new Promise((resolve) => remoteServer.listen(REMOTE_PORT, '127.0.0.1', resolve))
  console.log(
    `[jarvis] remote access listening on http://127.0.0.1:${remoteServer.address().port}` +
      ` for ${REMOTE.hosts.join(', ') || 'loopback only'} · ` +
      (REMOTE.requireCode ? `access code in ${REMOTE_FILE}` : 'no access code') +
      (REMOTE.restrictedToUsers ? ' · Tailscale account of the owner only' : ''),
  )
  if (!REMOTE.requireCode && !REMOTE.restrictedToUsers) {
    console.warn(
      '[jarvis] WARNING: remote access has no code and no JARVIS_REMOTE_USERS: anything that can reach this port is let in',
    )
  }
  if (!REMOTE.faceBuilt()) {
    console.warn('[jarvis] WARNING: no built interface to serve remotely — run `npm run build`')
  }
}
console.log(
  `[jarvis] MCP servers from config: ${Object.keys(MCP_SERVERS).join(', ') || 'none'}` +
    (ACCOUNT_CONNECTORS ? ' · account connectors ON' : ' · account connectors off'),
)
console.log(
  `[jarvis] writes ${ALLOW_WRITES ? 'ENABLED' : 'disabled'}` +
    (ALLOW_WRITES ? '' : ' — set JARVIS_ALLOW_WRITES=1 to permit shell/file/device actions'),
)
// Asynchronous, so it lands a beat after the rest of the banner. Worth printing
// at all because an extension that is simply not running is indistinguishable
// at the tool boundary from one that is broken, and this is the one place the
// difference can be stated before anybody asks a question that depends on it.
if (DISABLED.size) console.log(`[jarvis] disabled: ${[...DISABLED].join(', ')}`)
if (!DISABLED.has('browser')) void chromeAvailable().then((ok) => {
  console.log(
    ok
      ? `[jarvis] browser control ready${ALLOW_WRITES ? '' : ' (reading only — clicking and typing need JARVIS_ALLOW_WRITES=1)'}`
      : '[jarvis] browser control unavailable — open Chrome with the Claude extension enabled',
  )
})

console.log(
  '[jarvis] accepting local dev origins' +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)

/**
 * What to tell the browser when a turn ends badly. Plain sentences, because
 * whatever reaches the client is liable to be spoken.
 */
/** One interface connection, local or remote: see session.mjs. */
const onConnection = createSession({
  ACCOUNT_CONNECTORS,
  ALLOW_WRITES,
  BRAIN_MODE,
  BROWSER_TOOLS,
  CLAUDE_HEALTH,
  DISABLED,
  EFFORT,
  INBOX,
  LANGUAGE,
  LOCAL,
  LOCAL_SHELL,
  LOG_TALK,
  MCP_SERVERS,
  MODEL,
  RETRY_PATIENCE,
  SYSTEM_PROMPT,
  TOOL_ROOTS,
  TRACE,
  WORKSPACE,
  androidPcTools,
  claudeReachable,
  decideTool,
  enforcePolicy,
  said,
})

wss.on('connection', onConnection)
remoteWss?.on('connection', onConnection)
