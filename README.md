# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Objective and design principles

**JARVIS's objective is to become the most capable AI agent in the world.**
The LLM is the intelligence behind every capability: it understands the request,
decides what to do, chooses tools and combines them to complete the task.
Every feature must give the LLM new capabilities it can discover and use.
Task-specific intelligence and workflows must never be hardcoded as substitutes
for the LLM's reasoning. Code provides reliable tools, context, permissions and
execution; the LLM decides how to use them.

For example, when a user attaches a file from their phone and says **"put this
file on my PC in sandr/Images"**, JARVIS should use the attachment's actual
location, resolve the destination on the PC, transfer the file with the available
tools and verify that it arrived. In bridge mode, an uploaded phone attachment
is already in the PC's inbox. Using the phone interface must not make the agent
assume it cannot act on the computer.

Before declaring a task impossible, the LLM must inspect its available tools,
context and permissions and attempt the authorized action when supported. If a
real restriction blocks it, it must explain the specific missing permission,
tool or access, and how to unblock it. A blanket "I can't" for an action its
tools support is a capability failure to fix.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click anywhere once so the browser allows sound and the microphone, and say **“Hey Jarvis”** — or type in the field at the bottom.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click anywhere once, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly, or only the
ones you name in `JARVIS_MCP_SERVERS`. Depending on what you have installed, that
is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Servers you added through your **claude.ai
> account** (mail, drive, calendar and other account connectors) are not in `~/.claude.json`,
> but the CLI fetches them on its own and they join the session from the second
> turn. The bridge keeps them out by default; set `JARVIS_ACCOUNT_CONNECTORS=1`
> to let them in, and `JARVIS_MCP_SERVERS` to choose which `~/.claude.json`
> servers JARVIS gets.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| The text field | Write to him instead of speaking; Enter sends |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

On a touch screen there is a talk button at the bottom instead of the space
bar: press to wake him, press while he is answering to cut in, press while he is
listening to stand him down.

---

## Giving JARVIS a file

Drop a file anywhere on the window, paste one, or press the clip beside the
text field (on a phone it opens the system's picker). The file is uploaded to
the bridge, stored in its inbox (`~/.jarvis/workspace/inbox`, one folder per
day) and waits above the field until the next thing you say or type — then it
goes with that question. *"Summarise this"*, *"what is the total on this
invoice"*, or, with writes enabled, *"put it in my Documents folder"*.

The bytes never enter the conversation: the agent is told where the file is
and reads it with its own tools, so a long PDF costs nothing until you ask
about it. From a phone over the remote port the file lands on the computer,
which is where JARVIS works. The inbox is not emptied for you.

---

## When Claude is unavailable

JARVIS can keep a second, small brain on the machine and switch to it when
Claude cannot answer — no network, a usage limit reached, a login that has
lapsed, the service down. It is optional: without it nothing changes.

1. Install [Ollama](https://ollama.com) and pull the model:
   `ollama pull gemma4:e2b` (about 7 GB; it runs on a CPU, slowly).
2. Start JARVIS as usual. The bridge prints
   `[jarvis] local model gemma4:e2b ready — takes over when Claude cannot answer`.

The launcher reuses an Ollama that is already running. Otherwise it starts an
installed `ollama` automatically (including the standard Windows installation
or a portable copy in `.tools/ollama/`) and stops its own process with JARVIS.
`JARVIS_OLLAMA_EXECUTABLE` can name another executable. Models must be pulled
once before use; startup does not download them.

From then on a question Claude cannot take is answered by the local model
instead, before anything has been said, so you ask once and hear one answer.
The interface shows `LOCAL BRAIN` and why for as long as it lasts, and Claude
is tried again by itself a little later. The two brains share the conversation
— each is told what the other answered — and the same long-term memory.

The device catalogue is shared by Claude and the local model: files, memory,
display, web search, page reading and the PC shell when writes are enabled.
Both receive the real device folders, permissions and completed tool results.
The page retains completed conversation records across a bridge restart or
socket reconnection; each model's context window bounds what is sent.
Claude's account connectors still require the Claude service to be available.
`JARVIS_LOCAL_MODEL` names a larger model on a
machine that can carry it, `JARVIS_LOCAL_URL` can point at another computer's
Ollama, and `JARVIS_BRAIN=local` keeps everything on the machine.

---

## On your phone

`npm run remote` starts JARVIS exactly as `npm start` does and also makes that
same JARVIS reachable from your phone — same memory, same tools, same computer
behind it — from anywhere, over [Tailscale](https://tailscale.com), a private
network between your own devices. Nothing is opened to the internet.

1. Install Tailscale on the computer and on the phone, and sign in to the same
   account on both. In the Tailscale admin console, turn on MagicDNS and HTTPS
   certificates (a phone's browser will not give a page the microphone without
   HTTPS).
2. Run `npm run remote` (or `npm run remote:writes` to let JARVIS act, not only
   look). It prints the address to open and an access code.
3. On the phone, with Tailscale switched on, open that address, enter the code
   once, and use the browser's "Add to Home Screen" to keep it as an app.

Would rather not have a code at all — say, because you will be away from the
computer that shows it? Put `JARVIS_REMOTE_CODE=off` in `.env.local`. JARVIS
then lets in any device signed in to your own Tailscale account and asks it for
nothing.

What it does: builds the interface when the source has changed, starts the
bridge with a second, loopback-only port that serves it, points
`tailscale serve` at that port, and keeps the computer awake for as long as it
runs (`--allow-sleep` opts out). `npm run remote:off` takes the address down
again, and `npm run remote:autostart` starts all of this at Windows sign-in
(`-- --off` undoes it).

The computer has to be on: the phone is a second face, and the brain stays
where your files, your browser and your Claude login are. The page only listens
while it is on screen, so on a phone use the talk button rather than the wake
word. The camera JARVIS sees through is the phone's; the browser he drives is
the computer's.

---

## Android APK

The native Android app wraps this interface with Capacitor. It can use a PC
through Tailscale, Gemma locally through LiteRT-LM, or select the PC when it is
reachable and the phone otherwise. Android speech and shared-storage file tools
are native; a model is imported or downloaded once in **Réglages Android**.

See [the Android setup and verification guide](docs/android.md) for the fork,
GitHub Actions build, persistent signing secrets and phone installation. Native
code must pass the remote Gradle build and a real-device check before it can be
considered working. The PC-to-PC mesh in PLAN.md is still pending.

## The boot sequence

Off by default: the interface is live about a second after the page loads, and
sound and the microphone switch on with your first click, touch or key. Set
`VITE_BOOT_SEQUENCE=true` in `.env.local` for the cinematic opening instead —
an INITIALISE screen, then the sequence below.

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Frontend settings live in `.env.local`
(copy `.env.example`); bridge settings are environment variables.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_BRIDGE_HOST` | `127.0.0.1` | Interface to listen on. Any other address puts the agent on your network |
| `JARVIS_ALLOWED_HOSTS` | none | Extra hostnames the bridge answers to; a request for any other name gets a 403 |
| `JARVIS_REMOTE_PORT` | off | Second, loopback-only port for another device: serves the built interface and requires the access code. `npm run remote` sets it to `8788` |
| `JARVIS_REMOTE_HOSTS` | none | Names the remote port answers to, besides loopback — your machine's tailnet name. `npm run remote` fills it in |
| `JARVIS_REMOTE_CODE` | on | `off` asks other devices for no code: being signed in to your Tailscale account is then the only key |
| `JARVIS_REMOTE_ORIGINS` | none | Exact HTTPS app origins accepted by the remote port, e.g. `https://jarvis.app`; an allowed Tailscale identity is still required |
| `JARVIS_REMOTE_USERS` | none | Tailscale logins a remote request must come from. `npm run remote` fills in this machine's own account |
| `JARVIS_REMOTE_FILE` | `~/.jarvis/remote.json` | Where the access code and signing secret live. Delete it to sign every device out |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `medium` | Reasoning effort |
| `JARVIS_BRAIN` | `auto` | `auto` falls back to the local model when Claude cannot answer, `claude` never does, `local` uses only the local model |
| `JARVIS_LOCAL_MODEL` | `gemma4:e2b` | The Ollama model that stands in for Claude |
| `JARVIS_LOCAL_URL` | `http://127.0.0.1:11434` | Where Ollama listens; several addresses, comma separated, are tried in order |
| `JARVIS_LOCAL_CTX` | `8192` | Context window given to the local model, in tokens |
| `JARVIS_LOCAL_KEEP_ALIVE` | `5m` | How long Ollama keeps the model loaded after an answer; lengthen it when the local model is the brain rather than the understudy |
| `JARVIS_LOCAL_SHELL` | on | The device catalogue includes the PC shell when writes are on; `0` explicitly disables it |
| `JARVIS_INBOX` | `<workspace>/inbox` | Where files handed to JARVIS are stored |
| `JARVIS_UPLOAD_MAX_MB` | `1024` | Largest file accepted |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_MCP_SERVERS` | all configured | Comma-separated `~/.claude.json` servers to pass on; empty passes none |
| `JARVIS_ACCOUNT_CONNECTORS` | off | `1` lets your claude.ai account's connectors join the session |
| `JARVIS_DISABLE` | none | Comma-separated capabilities to leave out: `browser`, `camera`, `interface` |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_WORKSPACE` | `~/.jarvis/workspace` | The agent's working directory; file tools are confined to it and the temp directory |
| `JARVIS_FILE_ROOTS` | none | Extra folders the file tools and the `/file` endpoint may use |
| `JARVIS_KEEP_TRANSCRIPTS` | off | `1` keeps the SDK's session transcripts in `~/.claude/projects` |
| `JARVIS_CLAUDE_EXECUTABLE` | bundled CLI | Run the agent through this executable instead, e.g. a sandbox wrapper that execs the real CLI |
| `JARVIS_CHROME_PIPE` | none | WSL only: the Windows pipe name the browser relay connects to |
| `JARVIS_LOG_TALK` | off | `1` prints each question and each finished answer in the bridge terminal (never on disk) |
| `JARVIS_DEBUG` | off | `1` logs every agent message to the bridge terminal, answer text and tool calls included |
| `JARVIS_VOICE_ID` | none | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | none | Optional; enables the ElevenLabs voice + Scribe |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_BOOT_SEQUENCE` | `true` brings back the INITIALISE screen and the nine-second boot sequence |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time, in
`decideTool()` in `bridge/policy.mjs`. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

A `PreToolUse` hook applies that policy to every call, including the reads the
Claude Code CLI would otherwise approve by itself. In read-only mode the agent
has no shell, and its file tools reach only its workspace (`~/.jarvis/workspace`),
the temp directory and any folders in `JARVIS_FILE_ROOTS`. Paths that hold
credentials, such as `~/.ssh`, `~/.claude` and `.env` files, stay refused even
inside those folders.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

The script passes `--writes` to the bridge, so it works in Windows `cmd` and
PowerShell too. With `npm start`, use `npm start -- --writes`. Writes add `Bash`,
`Write`, `Edit` and `NotebookEdit` to the agent's tools. The file tools stay
inside the same folders; the shell can reach anything your user account can.

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`. If the port is taken,
the bridge says so in one line at startup and exits. It listens on `127.0.0.1`
only. Reaching it from another machine takes `JARVIS_BRIDGE_HOST` and
`JARVIS_ALLOWED_HOSTS`, and your own authentication in front of it first.

**Browser control on Windows.** The bridge finds the Claude extension's named
pipe, `\\.\pipe\claude-mcp-browser-bridge-<user>`, by itself. If the boot log
says the extension is not running, open Chrome with the extension signed in.
Each browser request looks for the pipe again, so the bridge does not need a
restart.

**Running the bridge in WSL, with Chrome on Windows.** Browser control works:
the Windows native host exposes a named pipe rather than a Unix socket, and the
bridge reaches it through a short PowerShell relay (WSL interop must be on,
which it is by default). Open the app at `http://127.0.0.1:5173` if
`localhost` is slow to load — Windows tries IPv6 loopback first, and WSL does
not forward it.

---

## Tests

Structured diagnostics are enabled by default. The PC writes rotating
`jarvis-trace-*.jsonl` files in `~/.jarvis/logs` (or `JARVIS_TRACE_DIR`). Each
record includes a timestamp, process session, event and conversation/turn or
request identifiers. The journal records user messages and retained history,
actual model input and available tools, model responses, tool arguments and
outcomes, policy denials, fallback decisions, interruptions and errors. Image
events include the requested URL, upstream HTTP status and content type, and
the viewer's load/error result. Browser errors require the updated interface.

`shared/trace.mjs` applies the same format and masking on Android and PC.
Android stores its traces in private app storage under `files/traces`, including
when disconnected; Android requests carry their conversation/turn IDs to the
PC. The optional browser-direct API mode stores records in IndexedDB
`jarvis-diagnostics`. Android logging requires an APK built from these sources.

Retention is approximately 100 MiB (10 files of 10 MiB); older records are
removed. Recognized secret fields/tokens are masked, binary media and internal
reasoning are omitted, and individual strings above 256 Ki characters carry an
explicit truncation marker. Conversations and file/tool text remain private
data: review traces before sharing them. `JARVIS_TRACE=0` disables PC traces;
the separate `JARVIS_DEBUG` and `JARVIS_LOG_TALK` console switches remain optional.
SDK transcripts controlled by `JARVIS_KEEP_TRANSCRIPTS` are independent.

`npm test` runs the bridge's tests with Node's built-in runner. They cover the
network binding, the tool policy, the MCP server allowlist, the remote port and
the WSL browser relay, which runs only under WSL. The network, allowlist and
remote tests start the bridge on a random loopback port, and none of the tests
opens a Claude session. The local brain, the fallback and file uploads are
tested through the real bridge against a fake Ollama, so they need neither
Ollama nor a network.

---

## Security

The bridge's defences live in `bridge/server.mjs` and `bridge/policy.mjs`:

- It listens on `127.0.0.1` and answers only requests addressed to `localhost`,
  `127.0.0.1` or `[::1]`, which blocks DNS rebinding.
- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A `PreToolUse` hook enforces the tool policy on every call. File tools stay
  inside the workspace, the temp directory and `JARVIS_FILE_ROOTS`, and
  `WebFetch` cannot reach loopback, LAN or cloud metadata addresses.
- claude.ai account connectors stay out of the session unless
  `JARVIS_ACCOUNT_CONNECTORS=1`, and `JARVIS_MCP_SERVERS` narrows which
  `~/.claude.json` servers the agent gets.
- Session transcripts are written to `~/.claude/projects` only when
  `JARVIS_KEEP_TRANSCRIPTS=1`.
- `JARVIS_DISABLE` removes browser control, the camera or the interface tools
  entirely, and `JARVIS_CLAUDE_EXECUTABLE` can run the agent inside a sandbox
  wrapper.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.
- An uploaded file is stored under a name reduced to a single safe path
  component, inside the inbox, up to `JARVIS_UPLOAD_MAX_MB`. The line that
  tells the agent about it is written by the bridge from paths it has checked,
  so a page cannot pass off an arbitrary path as a dropped file.
- The local model's file tools obey the same folder and credential rules as
  Claude's, write only with `JARVIS_ALLOW_WRITES`, and get a shell only with
  `JARVIS_LOCAL_SHELL=1` as well.
- Remote access (`bridge/remote.mjs`) is off by default and never loosens the
  rules above: it is a separate port, still on loopback, that accepts only its
  own page's origin and refuses every endpoint and the WebSocket without the
  access cookie. The cookie is `HttpOnly`, `Secure` and `SameSite=Strict`, and
  five wrong codes lock the exchange for five minutes. Requests are also
  checked against the Tailscale account `tailscale serve` attributes them to,
  which is the only check left when `JARVIS_REMOTE_CODE=off`. With `--writes`, a
  paired phone can do whatever JARVIS can do on the computer — pair only
  devices you would hand your unlocked computer to.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
