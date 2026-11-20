import { query } from '@anthropic-ai/claude-agent-sdk'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { UI_TOOLS } from '../shared/ui-tools.mjs'
import { DISPLAY_TOOLS } from '../shared/display-tools.mjs'
import { CAMERA_TOOLS } from '../shared/camera-tools.mjs'
import { chromeServer, isChromeTool } from './chrome.mjs'
import { visionServer } from './vision.mjs'
import { memoryPrompt, memoryServer, MEMORY_TOOLS } from './memory.mjs'
import { resetTime, unavailable } from './router.mjs'
import { localSystemPrompt, localToolGroups, localTools } from './local-tools.mjs'
import { deviceServer } from './device-server.mjs'
import { agentContext } from '../shared/agent-context.mjs'
import { appendExchange, retainedHistory } from '../shared/conversation.mjs'
import { recordClaudeMessage } from './claude-history.mjs'
import { traceData } from '../shared/trace.mjs'
import { readFile, stat } from 'node:fs/promises'
import { builtinTools } from './policy.mjs'

/**
 * One interface connection: its socket, its turns, the Claude session or the
 * local model answering them, and the tools built on its screen.
 *
 * Everything the bridge decides once at boot (configuration, policy, the
 * shared tool servers) is handed in; everything here belongs to one socket,
 * so two clients never share a turn.
 */

/** When Claude's usage limit resets, as last reported; shared by every connection. */
let rateResetAt = null

const RESULT_FAILURES = {
  error_during_execution: 'The turn failed part way through.',
  error_max_turns: 'The turn ran too long and was stopped.',
  error_max_budget_usd: 'The budget for this turn ran out.',
  error_max_structured_output_retries: 'The answer could not be assembled.',
  default: 'The turn ended without an answer.',
}

export function createSession({
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
}) {
  return (socket) => {
    console.log('[jarvis] client connected')

    // Answer the HUD straight away rather than making it wait for the agent's
    // first turn. Refined later by the real init message.
    socket.send(
      JSON.stringify({ type: 'ready', servers: Object.keys(MCP_SERVERS) }),
    )

    let socketClosed = false

    /**
     * Two brains, one conversation.
     *
     * Each question goes to Claude or to the local model (see `route` below),
     * and a question Claude turns out unable to answer is handed to the local
     * model before anything has been said. Neither brain can see the other's
     * turns, so the bridge keeps the exchanges itself and tells whichever one
     * takes over what it missed.
     */
    /** The question in hand: { id, text, images, brain, spoke, fallback, cancelled, done }. */
    let current = null
    let conversationId = crypto.randomUUID()
    const trace = (event, { conversationId: cid = conversationId, turnId = current?.id, ...data } = {}) =>
      TRACE.child({ conversationId: cid, turnId, brain: current?.brain }).record(event, data)
    void trace('connection.open')
    /** Finished exchanges, whoever answered them. */
    const transcript = []
    let completedCount = 0
    /** How much of the transcript the live Claude session has already seen. */
    let claudeSeen = 0
    /** The live Claude session, or null while there is none. */
    let claude = null
    /** Stops the local model's answer in flight. */
    let localAbort = null
    /** Which brain the interface was last told is answering. */
    let shownBrain = null

    const send = (msg) => {
      if (msg.type === 'blade' && msg.blade) msg = { ...msg, blade: { ...msg.blade, trace: { conversationId, turnId: current?.id } } }
      if (['blade', 'panel', 'capture', 'ui'].includes(msg.type)) void trace(`ui.${msg.type}`, { message: msg })
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
    }

    /**
     * Which question the agent is currently answering.
     *
     * The stream carries no notion of a turn, so without this the client cannot
     * tell the tail of an abandoned answer from the start of the new one — it
     * attaches a listener and receives whatever is on the socket. Echoing the
     * id the client sent lets it ignore anything that is not its own, which is
     * the only reliable fix: no amount of waiting on this side changes what a
     * listener over there has already heard.
     */
    let answering = null
    const sendTurn = (msg) => {
      if (msg.type === 'done') void trace('turn.end', { text: msg.text, costUsd: msg.costUsd })
      if (msg.type === 'error') void trace('turn.error', { message: msg.message })
      // Once a word has been spoken the turn cannot be quietly given to the
      // other brain: the user would hear two openings to one answer.
      if (msg.type === 'text' && current) current.spoke = true
      send({ ...msg, ask: answering })
    }

    function retainTurn(turn, messages, text = '') {
      const exchange = { id: turn.exchangeId, user: turn.text, jarvis: text, messages }
      if (!turn.retained) {
        completedCount++
        turn.retained = true
      }
      appendExchange(transcript, exchange)
      return transcript.find((entry) => entry.id === turn.exchangeId)
    }

    function checkpoint(turn, messages) {
      const exchange = retainTurn(turn, messages)
      if (exchange) send({ type: 'checkpoint', ask: turn.id, exchange })
    }

    /**
     * Asking the browser for something and waiting for the answer.
     *
     * Every other tool here pushes — a panel, a blade, a retint — and never needs
     * a reply. The camera is the exception: the hardware is over there and the
     * model is here, so a frame has to come back. Correlated by id because a turn
     * can have more than one request in flight, and timed out because a browser
     * that has been closed mid-question would otherwise hang the turn until the
     * two-minute idle timer noticed.
     */
    const waiting = new Map()
    let asks = 0

    const ask = (kind, args, timeoutMs = 20_000) =>
      new Promise((resolve, reject) => {
        if (socket.readyState !== socket.OPEN) {
          return reject(new Error('the interface is not connected'))
        }
        const id = `q${++asks}`
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new Error('the interface did not answer in time'))
        }, timeoutMs)
        waiting.set(id, { resolve, timer })
        send({ type: kind, id, ...args })
      })

    /**
     * Announcing a tool on the HUD, once, and only if it actually runs.
     *
     * A tool_use block surfaces twice — as a partial stream event and again on
     * the completed assistant message — so ids are remembered. The harder part
     * is timing, because a refused tool that lights the badge, plays the sound
     * and provokes a "working on it" line, for work that never happens, reads as
     * a bug on camera.
     *
     * The SDK's order is: the block starts streaming, then canUseTool is asked,
     * then the tool runs. So nothing is known at content_block_start. Announcing
     * from inside canUseTool would know the verdict but miss tools entirely —
     * measured on this SDK, the callback is consulted only for calls the CLI
     * hasn't already settled, so a `Bash: echo` its own classifier waves through
     * never reaches us at all.
     *
     * So: announce immediately for anything decideTool permits, since those run.
     * Hold the rest, and let the tool_result settle it — a refusal comes back as
     * is_error, anything else really did execute and has earned its badge, a
     * beat late. Nothing is ever announced for work that didn't happen.
     */
    const seenTools = new Set()
    const heldTools = new Map()

    /**
     * Resolves when the turn in flight has actually finished.
     *
     * Waiting on session.interrupt() alone is not enough. It resolves when the
     * agent has been *told* to stop, not when it has, so the last tokens of the
     * abandoned answer are still on their way — and since nothing on the wire
     * identifies which question a delta belongs to, they land on the next turn's
     * listener. Measured: ask for ALPHA, interrupt, ask for BRAVO, and BRAVO's
     * answer arrives as "ALPHA\nBRAVO".
     *
     * The SDK emits exactly one `result` per turn, so that is the boundary worth
     * waiting for — and it is waited for in full. It used to be raced against a
     * 400 ms timer, on the reasoning that a stray word beats a deadlock. But a
     * turn that outlived the timer did worse than leak a word: its `result`
     * arrived after the next question had been adopted and was reported as that
     * question's answer. Measured: ask for a count to sixty, cut in as it
     * starts, ask for BRAVO, and the answer to BRAVO was the whole count.
     *
     * So the next question now waits for the old turn's result, however long
     * the turn takes to wind down. The deadlock the timer guarded against is
     * handled where it belongs: a turn that has still not ended after
     * TURN_END_WAIT_MS takes its session with it (see stopClaudeTurn), and the
     * question goes to a new one.
     */
    let settling = Promise.resolve()
    let finishTurn = null
    /** Set while an interrupted Claude turn is being waited out. */
    let stopping = null

    /**
     * Which question a deliberate interrupt is cancelling.
     *
     * The SDK has no 'cancelled' result subtype — an interrupted turn comes back
     * as error_during_execution, identical at the result to a turn that genuinely
     * broke. Recording what was cancelled tells the two apart, so a barge-in
     * stops announcing a failure that did not happen. Held as the id rather than
     * a bare flag because an interrupt that arrives with no turn in flight would
     * otherwise leave the flag standing and swallow the next real failure.
     */
    let cancelledAsk = null

    const turnFinished = () =>
      new Promise((resolve) => {
        finishTurn = resolve
      })

    /**
     * How long an interrupted turn is given to report its result before its
     * session is given up on. An interrupt normally lands in a few hundred
     * milliseconds; this is for the turn that is stuck in something that will
     * not be interrupted.
     */
    const TURN_END_WAIT_MS = 4000

    /**
     * Stop the Claude turn in flight and hold the next question until it has
     * really ended.
     *
     * Every frame is tagged with the question being answered, and that tag only
     * moves on once `settling` resolves — so as long as it resolves no earlier
     * than the old turn's `result`, nothing of the old turn can be mistaken for
     * the new one. If the result does not come, the session is closed instead:
     * a closed session emits nothing more (the pump checks), and the next
     * question starts a fresh one that is told the conversation so far.
     */
    const stopClaudeTurn = () => {
      const turn = current
      const session = claude
      // Nothing of Claude's is in flight: nothing to stop, nothing to wait for.
      if (!session || !turn || turn.brain !== 'claude' || turn.done) return
      // Already being stopped; a second interrupt adds nothing.
      if (stopping) return
      // Marks the turn as cancelled on purpose, so the failed result it is
      // about to produce is not reported as a fault.
      cancelledAsk = turn.id
      const ended = turnFinished()
      // Not awaited: the wait below must start now even if the request to
      // interrupt is itself slow to be acknowledged.
      void Promise.resolve(session.interrupt()).catch(() => {})
      let timer
      stopping = Promise.race([
        ended.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), TURN_END_WAIT_MS)
        }),
      ]).then((finished) => {
        clearTimeout(timer)
        stopping = null
        if (finished || claude !== session || socketClosed) return
        console.warn('[jarvis] the interrupted turn did not end; replacing the Claude session')
        turn.done = true
        session.close()
        claude = null
        finishTurn = null
      })
      settling = stopping
    }

    /** Whatever is answering stops: a barge-in, or a new question overtaking an old one. */
    const stopCurrentTurn = () => {
      if (current && !current.done && !current.cancelled) void trace('turn.cancel', { reason: 'interrupt or replacement' })
      if (current) current.cancelled = true
      // The local model stops the moment its request is aborted, and whatever
      // it had left to say is discarded here — there is no tail to wait out.
      if (localAbort) {
        localAbort.abort()
        localAbort = null
        return
      }
      stopClaudeTurn()
    }

    const announceTool = (id, name) => {
      if (!name || (id && seenTools.has(id))) return
      if (id) seenTools.add(id)
      // The display tool isn't work being done, it's the HUD drawing itself —
      // announcing it would put "jarvis · display" in the tool badge and trigger
      // a "working on it" filler for something already on screen.
      if (name === 'mcp__jarvis__display') return
      // The ui_* tools are the same case one step further: retinting the
      // interface is the interface talking about itself, not work being done for
      // the user, and the badge would be describing the very thing they can see.
      if (name.startsWith('mcp__jarvis_ui__')) return
      // Noting a fact is not work the user is waiting on; no badge, no filler.
      if (name.startsWith('mcp__jarvis_memory__')) return
      if (decideTool(name)) return sendTurn({ type: 'tool', name })
      if (id) heldTools.set(id, name)
    }

    const settleTool = (id, failed) => {
      const name = heldTools.get(id)
      if (name === undefined) return
      heldTools.delete(id)
      if (!failed) sendTurn({ type: 'tool', name })
    }

    /** Tells the interface which brain is answering, when that changes. */
    const showBrain = (kind, reason = null) => {
      void trace('route.selected', { model: kind === 'local' ? LOCAL.model : MODEL, provider: kind, reason })
      if (shownBrain === kind) return
      const first = shownBrain === null
      shownBrain = kind
      // Claude answering the first question is the normal case, not news.
      if (first && kind === 'claude') return
      console.log(
        kind === 'local'
          ? `[jarvis] answering with the local model ${LOCAL.model}${reason ? ` (${reason})` : ''}`
          : '[jarvis] answering with Claude again',
      )
      send({ type: 'brain', brain: kind, model: kind === 'local' ? LOCAL.model : MODEL, reason })
    }

    /** The local model's tools, drawing on this connection's screen. */
    const localToolset = [...localTools({
      allowWrites: ALLOW_WRITES,
      cwd: WORKSPACE,
      roots: TOOL_ROOTS,
      shell: LOCAL_SHELL,
      show: (blade) => send({ type: 'blade', blade }),
      // The interface is redressed by the shared ui_* tools, whichever model asks.
      ...(DISABLED.has('interface') ? {} : { ui: (op, args) => send({ type: 'ui', op, args }) }),
      camera: !DISABLED.has('camera'),
      // The camera is in the browser: a frame is asked for and awaited. A forward
      // watch takes as long as it says it will, so it gets a longer timeout.
      ...(DISABLED.has('camera') ? {} : { capture: (request) => ask('capture', request, request.mode === 'watch' ? 45_000 : 20_000) }),
      // The player is in the browser, so the tool asks the browser and waits
      // for its answer: "next" on a single track has to come back as a reason,
      // not as a shrug. Quick, so a short leash.
      music: async (op) => {
        const reply = await ask('music', op, 10_000)
        if (reply?.error) throw new Error(String(reply.error))
        return String(reply?.text ?? 'Done.')
      },
    }), ...BROWSER_TOOLS]
    const host = { ...androidPcTools.manifest, cwd: WORKSPACE }
    const capabilityContext = agentContext({ tools: localToolset, host })

    /** Tools that are JARVIS keeping house, not work the user is waiting on. */
    const QUIET_LOCAL_TOOLS = new Set(['remember', 'forget', 'show', 'display', 'select_tools', ...UI_TOOLS])

    /**
     * One question, answered by the local model.
     *
     * It is given the recent exchanges every time and keeps nothing of its own
     * between questions: a small context is what keeps a small model quick.
     */
    const runLocal = async (turn, reason) => {
      turn.brain = 'local'
      showBrain('local', reason)
      const abort = new AbortController()
      localAbort = abort
      const mine = () => !abort.signal.aborted && !socketClosed && answering === turn.id
      let messages = []
      let progressAt = 0
      try {
        const images = []
        for (const path of turn.images ?? []) {
          // Small pictures only: each one is base64 in the model's context.
          const info = await stat(path).catch(() => null)
          if (info && info.size <= 6 * 1024 * 1024) images.push((await readFile(path)).toString('base64'))
        }
        // A turn starts with the core tools; the model loads the others itself.
        const grouped = localToolGroups(localToolset)
        const text = await LOCAL.turn(turn.text, {
          trace: (event, data) => TRACE.child({ conversationId, turnId: turn.id, brain: 'local' }).record(event, data),
          system: localSystemPrompt({
            language: LANGUAGE,
            roots: TOOL_ROOTS,
            inbox: INBOX.dir,
            allowWrites: ALLOW_WRITES,
            tools: localToolset, host,
          }) + (grouped.prompt ? `\n${grouped.prompt}` : ''),
          offer: grouped.offer,
          history: transcript.filter((entry) => entry.id !== turn.exchangeId),
          observations: turn.messages?.slice(1) ?? [],
          onMessages: (value) => { messages = value },
          onCheckpoint: (value) => checkpoint(turn, value),
          onProgress: () => {
            if (mine() && Date.now() - progressAt >= 5000) {
              progressAt = Date.now()
              sendTurn({ type: 'progress' })
            }
          },
          tools: [...localToolset, grouped.selector],
          images,
          signal: abort.signal,
          onText: (delta) => {
            if (mine()) sendTurn({ type: 'text', delta })
          },
          onTool: (name) => {
            if (mine() && !QUIET_LOCAL_TOOLS.has(name)) {
              sendTurn({ type: 'tool', name: `mcp__local__${name}` })
            }
          },
        })
        if (abort.signal.aborted) return
        const exchange = retainTurn(turn, messages, text)
        if (LOG_TALK) console.log(`[jarvis] answered (local): ${said(text)}`)
        if (mine()) sendTurn({ type: 'done', text, costUsd: 0, exchange })
      } catch (err) {
        if (abort.signal.aborted) return
        console.error(`[jarvis] local turn failed: ${err?.message ?? err}`)
        if (mine()) {
          sendTurn({
            type: 'error',
            message:
              BRAIN_MODE === 'local'
                ? `The local model is unavailable: ${err?.message ?? err}`
                : 'Claude is unavailable and the local model could not answer either.',
          })
        }
      } finally {
        turn.done = true
        if (localAbort === abort) localAbort = null
      }
    }

    /**
     * Why this question should go to the local model, or null if it should not.
     *
     * With no local model to fall back on the answer is always null, and the
     * bridge behaves as it did before there was a second brain.
     */
    const localReason = async () => {
      if (BRAIN_MODE === 'claude') return null
      if (BRAIN_MODE === 'local') return 'chosen'
      if (!(await LOCAL.available())) return null
      if (CLAUDE_HEALTH.down()) return CLAUDE_HEALTH.reason()
      if (!(await claudeReachable())) {
        CLAUDE_HEALTH.markDown('offline')
        return 'offline'
      }
      return null
    }

    /** What a Claude session is told about exchanges it did not see. */
    const recap = (exchanges) =>
      '[Context written by the machine, not said by the user: the earlier part of ' +
      'this conversation, which you do not otherwise remember. Carry on from it ' +
      'without mentioning it.\n' +
      exchanges
        .map((e) => e.messages?.length ? JSON.stringify(e.messages) : `User: ${e.user}\nJARVIS: ${e.jarvis}`)
        .join('\n') +
      ']\n\n'

    /** Claude has shown it cannot answer; the question in hand may change brains. */
    const noteClaudeDown = (reason) => {
      CLAUDE_HEALTH.markDown(reason, reason === 'rate_limit' ? rateResetAt : undefined)
      console.warn(`[jarvis] Claude is unavailable (${reason})`)
      if (current && current.brain === 'claude' && !current.spoke) current.fallback = reason
    }

    /** Send one question to whichever brain should answer it. */
    const route = async (text, id, files, history, exchangeId) => {
      if (!transcript.length) {
        transcript.push(...retainedHistory(history))
        completedCount = transcript.length
      }
      const turn = { id, exchangeId, text, images: [], messages: [], brain: null, spoke: false, fallback: null, cancelled: false, done: false }
      current = turn
      await trace('turn.start', { text, files, history: transcript })
      // Files that came with the question, named by the bridge from paths it
      // has checked for itself.
      if (files?.length) {
        const dropped = await INBOX.describe(files)
        turn.text = dropped.note + text
        turn.images = dropped.images
      }
      turn.messages.push({ role: 'user', content: turn.text })
      const why = await localReason()
      // The checks above take a moment; a newer question, an interrupt or a
      // closed page may have overtaken this one.
      if (current !== turn || turn.cancelled || socketClosed) return
      if (why) return runLocal(turn, why)

      claude ??= tryStartClaude()
      if (!claude) {
        // The CLI could not even be spawned. The local model answers when there
        // is one; otherwise this is the same failure claude-only mode reports.
        if (BRAIN_MODE === 'auto' && (await LOCAL.available())) {
          if (current !== turn || turn.cancelled || socketClosed) return
          return runLocal(turn, 'crashed')
        }
        turn.done = true
        return sendTurn({ type: 'error', message: 'Claude could not be started.' })
      }
      turn.brain = 'claude'
      showBrain('claude')
      const unseen = transcript.slice(Math.max(0, claudeSeen - (completedCount - transcript.length)))
      claudeSeen = completedCount
      claude.push(unseen.length ? recap(unseen) + turn.text : turn.text)
    }

    const claudeOptions = {
      // Everything Claude Code has configured, plus the HUD as an in-process
      // server. The HUD's handler closes over this socket, so a `display` call
      // lands on screen directly — which is also why this object is built per
      // connection rather than once.
      mcpServers: {
        ...MCP_SERVERS,
        // remember, forget, the screen and ui_* tools travel under jarvis_memory,
        // jarvis and jarvis_ui, once: the same entries, not a second copy.
        jarvis_device: deviceServer(localToolset.filter((entry) =>
          !MEMORY_TOOLS.has(entry.name) && !UI_TOOLS.has(entry.name) && !DISPLAY_TOOLS.has(entry.name) && !CAMERA_TOOLS.has(entry.name) && !isChromeTool(entry.name))),
        jarvis: displayServer(localToolset),
        // The interface controls, on the same socket. A separate key because
        // MCP tool names are `mcp__<key>__<tool>` and one key can only carry
        // one server; the underscore in it is why decideTool and announceTool
        // both name `jarvis_ui` explicitly.
        ...(DISABLED.has('interface')
          ? {}
          : { jarvis_ui: uiServer(localToolset) }),
        // The user's own Chrome, over the extension's native-host socket. It
        // holds no per-connection state, but it is built here with the rest so
        // the write gate is read once, at the same point as everything else.
        ...(DISABLED.has('browser')
          ? {}
          : { jarvis_chrome: chromeServer(localToolset) }),
        // The camera, which unlike everything else here has to ask and wait.
        ...(DISABLED.has('camera') ? {} : { jarvis_eyes: visionServer(localToolset) }),
        // Long-term memory: a file of facts that outlives the session.
        jarvis_memory: memoryServer(localToolset),
      },
      // A plain system prompt, not the claude_code preset. The preset is
      // tuned for a coding agent — verbose, file-oriented, and a large chunk
      // of input tokens on every turn. Replacing it makes the persona stick,
      // keeps answers short enough to speak, and cuts cost per turn. It is
      // added in startClaude, read afresh for each session, so what was
      // remembered last time is known now.
      //
      // Run from JARVIS's own workspace rather than the home directory. MCP
      // discovery does not depend on it — settingSources is empty and the
      // servers are passed in explicitly above — and file tools resolve
      // relative paths, and get auto-approved, only inside it.
      cwd: WORKSPACE,
      // Only the built-ins JARVIS uses. Everything else is not merely denied
      // but absent from the model's context. See builtinTools in policy.mjs.
      tools: builtinTools(ALLOW_WRITES),
      hooks: { PreToolUse: [{ hooks: [async (input) => {
        const verdict = await enforcePolicy(input)
        await trace('tool.start', { provider: 'claude', name: input.tool_name, callId: input.tool_use_id,
          arguments: input.tool_input, denied: verdict.hookSpecificOutput?.permissionDecision === 'deny' })
        return verdict
      }] }] },
      // No filesystem settings at all. Left to its default the SDK loads
      // ~/.claude/settings.json and settings.local.json exactly as the CLI
      // does — which on a working machine means a bypassPermissions default
      // and a pile of allow-rules for Bash. Allow-rules are matched before the
      // permission callback, so decideTool below would never even be asked
      // about the tools it most needs to refuse. Empty makes this bridge the
      // only authority. It also stops the global CLAUDE.md riding along on
      // every voice turn, carrying instructions written for a coding agent
      // into a conversation that is meant to be two sentences long.
      //
      // The cost is that MCP servers stop being discovered too, which is why
      // mcpServers above passes them in by hand.
      settingSources: [],
      strictMcpConfig: !ACCOUNT_CONNECTORS,
      // Stated explicitly, and it has to be.
      //
      // With no `model` here the SDK falls back to its own default, which on
      // this machine resolved to claude-opus-4-8[1m] — not what src/config.ts
      // declares for the browser-direct path, and not anything anyone chose.
      // Normally your own `/model` preference would decide, but that lives in
      // the settings files `settingSources: []` deliberately stops loading, so
      // without this line nothing in the project has a say at all.
      model: MODEL,
      effort: EFFORT,
      maxTurns: 24,
      // Nothing resumes a JARVIS session — every socket starts a new one — so
      // the transcript the SDK writes by default is only ever a record: every
      // question, every tool result (a page JARVIS read, a mail it opened, a
      // camera frame as base64) in ~/.claude/projects, beside your own Claude
      // Code history and listed by `claude --resume`. Off unless asked for.
      persistSession: process.env.JARVIS_KEEP_TRANSCRIPTS === '1',
      // Run the agent through something else — typically a sandbox wrapper
      // (bubblewrap, firejail, sandbox-exec) that execs the real CLI with the
      // arguments it was given. The SDK's bundled CLI is used when unset.
      ...(process.env.JARVIS_CLAUDE_EXECUTABLE
        ? { pathToClaudeCodeExecutable: process.env.JARVIS_CLAUDE_EXECUTABLE }
        : {}),
      permissionMode: 'default',
      // Without this the SDK only emits whole assistant messages, and JARVIS
      // would sit silent until the entire answer was written. Partial events
      // are what let speech start on the first finished sentence.
      includePartialMessages: true,
      // Signature is (toolName, input, options) and it must return a
      // PermissionResult object. Returning a bare boolean silently denies
      // everything, with the tool name arriving undefined.
      //
      // Worth knowing: this is the second gate, not the first. Calls the CLI
      // has already settled never arrive here — its own classifier waves
      // through a `Bash: cat file` or a Read inside the working directory
      // without asking. The PreToolUse hook above is what sees those; this
      // stays so that anything the CLI does ask about is still decided here.
      canUseTool: async (toolName) => {
        const ok = decideTool(toolName)
        console.log(`[jarvis] tool ${toolName} -> ${ok ? 'allow' : 'deny'}`)
        return ok
          ? { behavior: 'allow' }
          : {
              behavior: 'deny',
              // Every word of this can end up spoken, so it carries no command
              // to read out — the persona is forbidden from saying one aloud.
              message:
                'Blocked: JARVIS is running in read-only mode and cannot take' +
                ' actions that change anything. Tell the user this action is' +
                ' unavailable until they enable write access on the machine.',
            }
      },
    }

    /**
     * One Claude session: the SDK query, the queue that feeds it, and the pump
     * that carries its output to the browser.
     *
     * A function rather than a single session per socket, because a session can
     * now be lost without the conversation being over: one that crashes, or is
     * dropped while stuck retrying, is replaced by a new one the next time
     * Claude is given a question.
     */
    const startClaude = () => {
      /** Resolves the pending user message into the SDK's input generator. */
      let deliver = null
      let closed = false
      const inbox = []

      async function* userMessages() {
        while (!closed) {
          const text =
            inbox.shift() ??
            (await new Promise((resolve) => {
              deliver = resolve
            }))
          if (closed || text == null) return
          await trace('model.input', { provider: 'claude', model: MODEL, text })
          yield {
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
          }
        }
      }

      const systemPrompt = SYSTEM_PROMPT + '\n' + capabilityContext + memoryPrompt()
      void trace('model.context', { provider: 'claude', model: MODEL, system: systemPrompt, tools: localToolset.map(({ name, description, parameters }) => ({ name, description, parameters })) })
      const session = query({
        prompt: userMessages(),
        options: { ...claudeOptions, systemPrompt },
      })

      const handle = {
        push(text) {
          if (deliver) {
            const resolve = deliver
            deliver = null
            resolve(text)
          } else {
            inbox.push(text)
          }
        },
        interrupt: () => session.interrupt?.(),
        /** True once this side has closed it — as opposed to it dying. */
        get closed() {
          return closed
        },
        close() {
          if (closed) return
          closed = true
          deliver?.(null)
          session.close?.()
        },
      }

      // A new session knows nothing of what was said before it existed, so the
      // last few exchanges ride in with its first question.
      claudeSeen = 0
      void pump(session, handle)
      return handle
    }

    /**
     * A session that is over, for whatever reason.
     *
     * It used to mean the socket was closed so the page would reconnect — into a
     * new session that failed the same way. With a local model to hand, the
     * conversation carries on there instead, and Claude is tried again later.
     */
    /**
     * Starting the CLI can throw outright — Windows refusing a spawn when many
     * pages connect at once. That is Claude being unavailable for this
     * connection, not a reason for the whole bridge to stop.
     */
    const tryStartClaude = () => {
      try {
        return startClaude()
      } catch (err) {
        console.error('[jarvis] Claude could not start:', err?.message ?? err)
        if (BRAIN_MODE === 'auto') CLAUDE_HEALTH.markDown('crashed')
        return null
      }
    }

    const sessionEnded = async (handle, err) => {
      const ours = handle.closed
      handle.close()
      if (claude === handle) claude = null
      // Closed on purpose: the page went away, or the turn was handed over.
      if (ours || socketClosed) return

      console.error('[jarvis] session error:', err ?? 'the session ended unexpectedly')
      finishTurn?.()
      finishTurn = null
      const turn = current
      const midTurn = turn && turn.brain === 'claude' && !turn.done
      if (BRAIN_MODE === 'auto' && (await LOCAL.available())) {
        CLAUDE_HEALTH.markDown('crashed')
        if (socketClosed || !midTurn || current !== turn) return
        if (!turn.spoke) return void runLocal(turn, 'crashed')
        turn.done = true
        return sendTurn({ type: 'error', message: 'The answer was cut short.' })
      }
      send({ type: 'error', message: String(err?.message ?? err ?? 'The session ended.') })
      // The stream is finished either way — nothing will ever be read from it
      // again. Leaving the socket open would leave the client believing it has
      // a working bridge, and every later question would hang for ever waiting
      // on a pump that has already stopped. Close it so it reconnects.
      socket.close()
    }

    // Pump the session's output stream to the browser for as long as it lives.
    const pump = async (session, handle) => {
      // The opening of each assistant message is held back until it is clearly
      // an answer: a finished sentence followed by more, another block, or the
      // end of the message. If a tool call starts first, the held text was
      // narration ("I'll search for that") — the prompt forbids it, the model
      // says it anyway, often in English whatever the user spoke, and the
      // filler line has already covered the wait. So it is dropped, not spoken.
      let held = ''
      let holding = false
      const flushHeld = () => {
        if (holding && held) sendTurn({ type: 'text', delta: held })
        held = ''
        holding = false
      }
      let failure = null
      try {
        for await (const msg of session) {
          // A session closed from this side — replaced, or its turn handed to
          // the local model — may still have messages buffered. They belong to
          // nobody now, and must not be tagged as the current question's.
          if (handle.closed) break
          if (current?.brain === 'claude' && !current.done && recordClaudeMessage(current.messages, msg)) {
            checkpoint(current, current.messages)
          }
          if (msg.type === 'assistant' && !msg.error) await trace('model.response', { provider: 'claude', content: msg.message?.content ?? msg.content })
          if (msg.type === 'assistant' && msg.error) await trace('model.error', { provider: 'claude', error: msg.error })
          if (msg.type === 'system' && msg.subtype === 'init') await trace('model.capabilities', { provider: 'claude', model: msg.model, tools: msg.tools, servers: msg.mcp_servers })
          if (msg.type === 'result') await trace('model.result', { subtype: msg.subtype, errors: msg.errors, usage: msg.usage, costUsd: msg.total_cost_usd })
          if (process.env.JARVIS_DEBUG === '1') {
            console.log(
              '[msg]',
              msg.type,
              msg.event?.type ?? '',
              msg.type === 'result' ? `subtype=${msg.subtype} result=${JSON.stringify(msg.result)}` : '',
              msg.type === 'assistant' ? JSON.stringify(traceData(msg.message?.content ?? msg.content)) : '',
              msg.type === 'system' && msg.subtype === 'init' ? JSON.stringify(msg.mcp_servers) : '',
            )
          }

          switch (msg.type) {
            // Raw Anthropic stream events, surfaced by includePartialMessages.
            // This is the ONLY place spoken text arrives: there is no top-level
            // text_delta message in the SDK union and the 'assistant' message
            // carries no deltas either. Turn includePartialMessages off and
            // JARVIS goes completely mute.
            case 'stream_event': {
              const ev = msg.event
              if (ev?.type === 'message_start') {
                held = ''
                holding = true
              }
              if (
                ev?.type === 'content_block_delta' &&
                ev.delta?.type === 'text_delta' &&
                ev.delta.text
              ) {
                if (holding) {
                  held += ev.delta.text
                  if (/[.!?…]\s+\S/.test(held)) flushHeld()
                } else {
                  sendTurn({ type: 'text', delta: ev.delta.text })
                }
              }
              if (
                ev?.type === 'content_block_start' &&
                ev.content_block?.type === 'tool_use'
              ) {
                if (held && process.env.JARVIS_DEBUG === '1') {
                  console.log('[jarvis] dropped pre-tool narration:', JSON.stringify(held))
                }
                held = ''
                holding = false
                announceTool(ev.content_block.id, ev.content_block.name)
              } else if (
                (ev?.type === 'content_block_start' && held) ||
                ev?.type === 'message_delta' ||
                ev?.type === 'message_stop'
              ) {
                flushHeld()
              }
              break
            }

            case 'assistant': {
              // Fallback for builds that emit whole assistant messages rather
              // than partial events. Deduped against the stream_event path.
              for (const block of msg.content ?? msg.message?.content ?? []) {
                if (block.type === 'tool_use') {
                  announceTool(block.id, block.name)
                }
              }
              // An assistant message can be the CLI reporting that there is no
              // assistant: the limit is reached, the login has lapsed, the API
              // is down. Its text is an error notice, not an answer — noted
              // here, and acted on when the turn's result arrives.
              if (unavailable(msg.error)) noteClaudeDown(msg.error)
              break
            }

            case 'rate_limit_event':
              // Only remembered: the refused turn itself reports as an error on
              // its assistant message, and this says how long the wait is.
              if (msg.rate_limit_info?.status === 'rejected') {
                rateResetAt = resetTime(msg.rate_limit_info.resetsAt)
              }
              break

            case 'user': {
              // Tool results come back as a user message. This is the only place
              // a held announcement can be resolved: a refused tool arrives with
              // is_error set and stays off the HUD, anything else ran.
              const blocks = msg.message?.content
              if (!Array.isArray(blocks)) break
              for (const block of blocks) {
                if (block?.type === 'tool_result') {
                  await trace('tool.result', { provider: 'claude', callId: block.tool_use_id, result: block.content, failed: block.is_error === true })
                  settleTool(block.tool_use_id, block.is_error === true)
                }
              }
              break
            }

            case 'result': {
              const turn = current
              const cancelled = cancelledAsk !== null && cancelledAsk === answering
              // A result is not automatically a success. The error subtypes
              // carry no `result` field at all, so reporting them as 'done' with
              // empty text is indistinguishable from a turn that simply had
              // nothing to say — the HUD stops spinning and JARVIS stands there
              // silent. Say what happened instead.
              if (!turn || turn.brain !== 'claude') {
                // The tail of a turn the local model has already taken over:
                // nothing here is anybody's answer any more.
              } else if (
                !cancelled &&
                !turn.spoke &&
                BRAIN_MODE === 'auto' &&
                turn.fallback &&
                (await LOCAL.available())
              ) {
                // Claude could not answer and nothing has been said yet, so the
                // same question goes to the local model. This is the whole of
                // the fallback: the user asked once and hears one answer.
                console.warn(`[jarvis] Claude could not take this turn (${turn.fallback}); the local model does`)
                if (current === turn && !socketClosed) void runLocal(turn, turn.fallback)
              } else if (msg.subtype === 'success') {
                turn.done = true
                // An answer is the proof that Claude is back.
                if (!turn.fallback) CLAUDE_HEALTH.markUp()
                if (turn.messages.at(-1)?.role !== 'assistant') turn.messages.push({ role: 'assistant', content: msg.result ?? '' })
                const exchange = retainTurn(turn, turn.messages, msg.result ?? '')
                claudeSeen = completedCount
                if (LOG_TALK) console.log(`[jarvis] answered: ${said(msg.result)}`)
                sendTurn({
                  type: 'done',
                  text: msg.result ?? '',
                  costUsd: msg.total_cost_usd ?? null,
                  exchange,
                })
              } else if (cancelled) {
                turn.done = true
                // Cancelled on purpose. The client bumps its turn counter before
                // interrupting, so it is already discarding anything tagged with
                // this id — sending an error would be a message nobody reads,
                // and logging one puts a failure in the log for a feature that
                // worked.
                console.log('[jarvis] turn interrupted')
              } else {
                turn.done = true
                console.error(
                  `[jarvis] turn failed: ${msg.subtype}`,
                  msg.errors ?? '',
                )
                sendTurn({
                  type: 'error',
                  message: RESULT_FAILURES[msg.subtype] ?? RESULT_FAILURES.default,
                })
              }
              cancelledAsk = null
              // Whatever was waiting on this turn to finish can go now. This is
              // the only place a turn is genuinely over.
              finishTurn?.()
              finishTurn = null
              // One turn's tool ids are never referred to again, and these
              // otherwise grow for as long as the socket is open.
              seenTools.clear()
              heldTools.clear()
              break
            }

            case 'system':
              // The CLI retries a failed request for minutes before it gives
              // up. A voice turn does not have minutes: after a couple of
              // attempts, with nothing said yet and a local model to hand, the
              // stuck session is dropped and the question changes brains. A new
              // session starts when Claude is next tried.
              if (msg.subtype === 'api_retry' && msg.attempt >= RETRY_PATIENCE) {
                const turn = current
                if (
                  BRAIN_MODE === 'auto' &&
                  turn &&
                  turn.brain === 'claude' &&
                  !turn.spoke &&
                  !turn.done &&
                  (await LOCAL.available()) &&
                  current === turn &&
                  claude === handle &&
                  !socketClosed
                ) {
                  const reason = unavailable(msg.error) ? msg.error : 'server_error'
                  CLAUDE_HEALTH.markDown(reason)
                  console.warn(`[jarvis] Claude is not answering (${reason}); the local model takes this turn`)
                  handle.close()
                  claude = null
                  finishTurn?.()
                  finishTurn = null
                  void runLocal(turn, reason)
                }
              }
              if (msg.subtype === 'init') {
                // Servers report 'pending' until first use — they connect
                // lazily — so only drop the ones that are actually unusable.
                const usable = (msg.mcp_servers ?? [])
                  .filter((s) => s.status !== 'needs-auth' && s.status !== 'failed')
                  .map((s) => s.name)
                send({ type: 'ready', servers: usable })
                console.log(`[jarvis] ${usable.length} MCP servers available`)
              }
              break
          }
        }
      } catch (err) {
        failure = err
      }
      // A stream that simply stops is as final as one that throws.
      await sessionEnded(handle, failure)
    }

    socket.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (msg.type === 'ask' && typeof msg.text === 'string') {
        if (typeof msg.conversationId === 'string' && /^[\w-]{1,80}$/.test(msg.conversationId)) conversationId = msg.conversationId
        /**
         * Queued behind any interrupt that is still settling.
         *
         * A barge-in is two messages in quick succession — interrupt, then the
         * new question — and session.interrupt() is asynchronous. Delivering the
         * question the instant it arrives means the agent can still be winding
         * down the previous turn, so its last tokens are emitted after the new
         * one has begun and land on the new turn's listener. Measured: ask "one",
         * interrupt, ask "two", and the answer to "two" comes back as "One."
         *
         * Waiting costs nothing when nothing is interrupting — the chain is an
         * already-resolved promise — and removes the cross-talk when there is.
         *
         * The interface always interrupts before it asks again, but the rule
         * should not rest on that: a question that arrives while another is
         * still being answered stops it here, by the same route.
         */
        stopCurrentTurn()
        const text = msg.text
        if (LOG_TALK) console.log(`[jarvis] asked: ${said(text)}`)
        const id = typeof msg.id === 'string' ? msg.id : null
        const exchangeId = typeof msg.exchangeId === 'string' && /^[\w-]{1,80}$/.test(msg.exchangeId) ? msg.exchangeId : crypto.randomUUID()
        // Files dropped on the interface since the last question. Only paths;
        // the bridge checks each one is really in its inbox before naming it.
        const files = Array.isArray(msg.files)
          ? msg.files.filter((f) => typeof f === 'string')
          : []
        void settling.then(() => {
          answering = id
          void route(text, id, files, msg.history, exchangeId).catch((err) => {
            console.error('[jarvis] could not route the question:', err)
            if (answering === id) sendTurn({ type: 'error', message: 'The question could not be delivered.' })
          })
        })
      }

      if (msg.type === 'reply' && typeof msg.id === 'string') {
        const slot = waiting.get(msg.id)
        if (slot) {
          waiting.delete(msg.id)
          clearTimeout(slot.timer)
          slot.resolve(msg)
        }
      }

      if (msg.type === 'interrupt') stopCurrentTurn()
      if (msg.type === 'trace' && /^image\.(loaded|error)$/.test(msg.event ?? '') && JSON.stringify(msg.data ?? {}).length <= 32768) {
        void trace(msg.event, { origin: 'viewer', ...msg.data, conversationId: msg.data?.conversationId ?? msg.conversationId ?? conversationId })
      }
    })

    socket.on('close', () => {
      console.log('[jarvis] client disconnected')
      socketClosed = true
      void trace('connection.close')
      localAbort?.abort()
      claude?.close()
    })

    // Started now rather than with the first question, so the CLI is already up
    // when it comes. Not while Claude is known to be out of reach: the session
    // would only fail, and the first question is going to the local model.
    if (BRAIN_MODE === 'local') showBrain('local', 'chosen')
    else if (!CLAUDE_HEALTH.down()) claude = tryStartClaude()
  }
}
