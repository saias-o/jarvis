/**
 * The local brain: a small model on this machine, for when Claude cannot answer.
 *
 * It talks to Ollama (https://ollama.com), which runs open models behind a
 * local HTTP API. The default is `gemma4:e2b` — small enough for a laptop with
 * no graphics card worth the name — and JARVIS_LOCAL_MODEL names anything
 * larger the machine can carry.
 *
 * This is deliberately NOT Claude Code pointed at another endpoint. Ollama can
 * imitate the Anthropic API, and the whole agent would then run unchanged, but
 * that agent arrives with tens of thousands of tokens of tool schemas: a
 * two-billion-parameter model on a CPU spends minutes reading them and then
 * calls the wrong one. So the stand-in gets its own loop — a short prompt, a
 * shared device catalogue (local-tools.mjs). Complete conversation records,
 * including tool observations, use the same format as the other brains; the
 * model's context window decides how much can be sent on each step.
 *
 * Nothing here imports the Agent SDK, so the loop can be tested against a fake
 * Ollama (test/local-brain.test.mjs).
 */

import { agentTurn } from '../shared/agent-loop.mjs'
import { fitContext } from '../shared/context-window.mjs'

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

export function localConfig(env = process.env) {
  return {
    /**
     * Where to look for the model, in order. More than one lets a weak machine
     * borrow a stronger one's Ollama over the tailnet when its own is absent.
     */
    urls: (env.JARVIS_LOCAL_URL?.trim() || 'http://127.0.0.1:11434')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    model: env.JARVIS_LOCAL_MODEL?.trim() || 'gemma4:e2b',
    /**
     * Ollama's own default context is 4,096 tokens, which the prompt and one
     * file excerpt already fill. 8,192 leaves room for a conversation and
     * still fits in the memory a small machine has to spare.
     */
    ctx: clamp(Number(env.JARVIS_LOCAL_CTX) || 8192, 2048, 131_072),
    /** How long Ollama keeps the model loaded after an answer. */
    keepAlive: env.JARVIS_LOCAL_KEEP_ALIVE?.trim() || '30m',
    /**
     * Whether the model may reason before answering. Off by default: on a CPU a
     * reasoning Gemma spends 50 to 160 tokens thinking before a one-line answer
     * (a minute or more on a small machine), and with the tool groups it calls
     * its tools without it. JARVIS_LOCAL_THINK=1 trades that time for more
     * careful arguments.
     */
    think: /^(1|true|on|yes)$/i.test(env.JARVIS_LOCAL_THINK?.trim() ?? ''),
  }
}

/** `gemma4` and `gemma4:latest` are the same model to Ollama. */
const tagged = (name) => {
  const n = String(name ?? '').trim().toLowerCase()
  return n.includes(':') ? n : `${n}:latest`
}

const clip = (text, max) => {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * @param {ReturnType<typeof localConfig>} config
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]  Injectable for tests.
 */
export function createLocal(config = localConfig(), { fetchImpl = fetch, now = Date.now } = {}) {
  const { urls, model, ctx, keepAlive, think = false } = config
  /** Models that refuse a reasoning setting are sent none from then on. */
  const noThinkSetting = new Set()

  /**
   * Which Ollama has the model, checked in the background.
   *
   * Every question consults this, so it must cost nothing: on Windows a
   * connection to a port nobody is listening on takes a second or more to be
   * refused, and paying that per turn — on a machine with no Ollama at all —
   * would slow down the brain that does work. The answer in hand is returned
   * at once and refreshed behind it; only the very first call waits.
   */
  const TTL_MS = 30_000
  let found = null // { at, url } | { at, problem }
  let looking = null

  async function look() {
    let problem = `no Ollama answering at ${urls.join(', ')}`
    for (const url of urls) {
      try {
        const res = await fetchImpl(`${url}/api/tags`, { signal: AbortSignal.timeout(2500) })
        if (!res.ok) continue
        const names = ((await res.json()).models ?? []).flatMap((m) => [m?.name, m?.model])
        if (names.some((name) => name && tagged(name) === tagged(model))) return { url }
        problem = `the model ${model} is not on ${url} — run: ollama pull ${model}`
      } catch {
        /* not there; try the next */
      }
    }
    return { problem }
  }

  function refresh() {
    looking ??= look()
      .then((result) => {
        found = { ...result, at: now() }
        return found
      })
      .finally(() => {
        looking = null
      })
    return looking
  }

  /** { url } when the model can be used, { problem } when it cannot. */
  async function locate() {
    if (!found) return refresh()
    if (now() - found.at > TTL_MS) void refresh()
    return found
  }

  async function* chat(url, body, signal) {
    const post = (payload) => fetchImpl(`${url}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal,
    })
    // Reasoning off unless asked for (see localConfig). A model without a
    // reasoning mode rejects the setting: it is then left at its default.
    const key = `${url} ${model}`
    let res = await post(think || noThinkSetting.has(key) ? body : { ...body, think: false })
    if (!think && !noThinkSetting.has(key) && res.status === 400) {
      const reason = await res.text()
      if (!/think/i.test(reason)) throw new Error(`the local model answered 400: ${clip(reason, 200)}`)
      noThinkSetting.add(key)
      res = await post(body)
    }
    if (!res.ok) {
      // A model that has gone since the last look should be looked for again.
      found = null
      throw new Error(`the local model answered ${res.status}: ${clip(await res.text(), 200)}`)
    }

    // One JSON object per line, split wherever the network cut it.
    const decoder = new TextDecoder()
    let buffer = ''
    const parse = (line) => {
      const chunk = JSON.parse(line)
      if (chunk.error) throw new Error(`the local model failed: ${clip(chunk.error, 200)}`)
      return chunk
    }
    for await (const bytes of res.body) {
      buffer += decoder.decode(bytes, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) yield parse(line)
      }
    }
    if (buffer.trim()) yield parse(buffer.trim())
  }

  /**
   * One question, answered: the model speaks, or calls tools and then speaks.
   *
   * @param {string} text
   * @param {object} opts
   * @param {string} opts.system
   * @param {{user:string, jarvis:string}[]} [opts.history]  Earlier exchanges, oldest first.
   * @param {{name:string, description:string, parameters:object, run:Function}[]} [opts.tools]
   * @param {string[]} [opts.images]   Base64 images that came with the question.
   * @param {AbortSignal} [opts.signal]
   * @param {(delta:string)=>void} [opts.onText]
   * @param {(name:string)=>void} [opts.onTool]
   * @param {number} [opts.maxSteps]   Model calls allowed, the last one without tools.
   * @param {(specs: object[]) => object[]} [opts.offer]  Narrows the schemas sent at each step (tool groups).
   * @returns {Promise<string>} Everything that was said.
   */
  async function turn(
    text,
    { system, history = [], tools = [], images = [], signal, onText, onTool, onMessages, onCheckpoint, onProgress, trace, observations = [], maxSteps = 6, offer: narrow } = {},
  ) {
    const where = await locate()
    if (where.problem) throw new Error(where.problem)

    return agentTurn(text, {
      system, history, tools, images, signal, onText, onTool, onMessages, onCheckpoint, onProgress, trace, observations, maxSteps,
      chat: async function* (messages, all, abort) {
        const offer = narrow ? narrow(all) : all
        const fitted = fitContext(messages, offer, ctx * 3)
        await trace?.('model.input', { provider: 'ollama', model, endpoint: where.url, messages: fitted, tools: offer, contextTokens: ctx })
        yield* chat(where.url, {
          // Keep complete observations while they fit; discard oldest exchanges
          // before shortening older outputs within the current action sequence.
          model, messages: fitted, ...(offer.length ? { tools: offer } : {}),
          stream: true, keep_alive: keepAlive,
          options: { num_ctx: ctx, temperature: 0.3 },
        }, abort)
      },
    })
  }

  return {
    model,
    urls,
    /** True when a question could be answered here right now. */
    available: async () => !(await locate()).problem,
    /** Why not, in a sentence — or null. */
    problem: async () => (await locate()).problem ?? null,
    /** Look again now, e.g. after the user installs the model. */
    refresh,
    turn,
  }
}
