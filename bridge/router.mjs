/**
 * Which brain answers: Claude Code, or the local model standing in for it.
 *
 * JARVIS used to have one brain and no plan for losing it. Off the network,
 * past a usage limit, or with a login that had lapsed, every question ended in
 * the same spoken error. The bridge now keeps a second, much smaller brain on
 * the machine itself (see local.mjs) and this file decides when to use it.
 *
 * Kept free of the Agent SDK and of any socket so the rules can be tested on
 * their own: what counts as "unavailable", how long to stay away, and how to
 * tell that the network is gone before a question is spent finding out.
 */

import { connect } from 'node:net'

/**
 *   auto   — Claude when it can answer, the local model when it cannot.
 *   claude — Claude only; a failure is reported, as it always was.
 *   local  — the local model only. Nothing leaves the machine.
 */
export const BRAIN_MODES = ['auto', 'claude', 'local']

/** A typo must not silently pick a brain, so anything unknown is `auto`. */
export function brainMode(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  return BRAIN_MODES.includes(value) ? value : 'auto'
}

const MINUTE = 60_000

/**
 * Why Claude cannot answer, and how long to leave it alone before trying again.
 *
 * The keys are the SDK's own assistant-message errors, plus two of ours:
 * `offline` (the network probe below failed) and `crashed` (the session died).
 * Errors that are about one request rather than about Claude — a malformed
 * request, an answer that ran out of room — are deliberately absent: a second
 * brain would not have fared better, and falling back would hide a real fault.
 *
 * The waits are short because finding out is cheap. A turn sent to a Claude
 * that is still down fails within a second or two and is answered locally
 * anyway, so the cost of asking too soon is one slightly slower answer.
 */
export const COOLDOWN_MS = {
  offline: 20_000,
  overloaded: MINUTE,
  server_error: MINUTE,
  unknown: MINUTE,
  crashed: MINUTE,
  rate_limit: 5 * MINUTE,
  authentication_failed: 10 * MINUTE,
  oauth_org_not_allowed: 10 * MINUTE,
  billing_error: 10 * MINUTE,
  model_not_found: 10 * MINUTE,
}

/** Never stay away longer than this on the word of a single reset time. */
const LONGEST_WAIT_MS = 15 * MINUTE

/** True when `error` means Claude itself is out of reach, not that one request was bad. */
export const unavailable = (error) =>
  typeof error === 'string' && Object.hasOwn(COOLDOWN_MS, error)

/**
 * A rate-limit reset time as milliseconds since the epoch, or null.
 * The SDK does not say which unit `resetsAt` is in, so both are accepted.
 */
export function resetTime(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? n * 1000 : n
}

/**
 * Whether Claude is believed to be down, and until when.
 *
 * One of these is shared by every connection: a usage limit reached on the
 * phone is just as reached on the computer.
 */
export function createHealth(now = Date.now) {
  let until = 0
  let reason = null
  return {
    /** `resumeAt` — when the limit lifts, if the API said so. */
    markDown(why, resumeAt) {
      const wait = COOLDOWN_MS[why] ?? MINUTE
      const at = now()
      until =
        resumeAt && resumeAt > at ? Math.min(resumeAt, at + LONGEST_WAIT_MS) : at + wait
      reason = why
    },
    markUp() {
      until = 0
      reason = null
    },
    down: () => now() < until,
    reason: () => (now() < until ? reason : null),
    until: () => until,
  }
}

function tcpDial(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const finish = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * Is the network there at all?
 *
 * Without this, the first sign of being offline is the CLI retrying a request
 * it cannot send, and the user waits through that before the local model gets
 * the question. One TCP handshake answers it in a few tens of milliseconds
 * when the network is up, and is remembered for half a minute.
 *
 * It measures a direct route only. Behind a proxy, or with the CLI pointed at
 * another endpoint or cloud, a failed handshake would mean nothing — so there
 * the probe always says yes and the in-flight errors do the deciding.
 */
export function createProbe({
  host = 'api.anthropic.com',
  port = 443,
  timeoutMs = 1500,
  okTtlMs = 30_000,
  badTtlMs = 8_000,
  dial = tcpDial,
  now = Date.now,
  env = process.env,
} = {}) {
  const indirect = [
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
  ].some((name) => String(env[name] ?? '').trim())

  let last = null
  let pending = null

  return async function reachable() {
    if (indirect) return true
    if (last && now() - last.at < (last.ok ? okTtlMs : badTtlMs)) return last.ok
    pending ??= dial(host, port, timeoutMs)
      .then((ok) => {
        last = { ok: Boolean(ok), at: now() }
        return last.ok
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
}
