import { isAndroid } from './android'
import * as device from './device'
import { androidRoute } from '../../shared/android-agent.mjs'
import { readDeviceSettings } from './deviceSettings'
import { BRIDGE_HTTP_URL, selectBridge } from '../config'
import { bridgeFetch } from './bridgeAuth'
import { BACKEND } from '../config'
import * as direct from './anthropic'
import * as bridge from './bridge'
import type { AskHandlers, Msg } from './anthropic'
import type { Blade, BrainInfo } from '../store'

export type { AskHandlers, Msg }
export type { ConnectionState } from './bridge'

/**
 * Picks the brain. Both backends answer a question and stream text and tool
 * events back; they differ in where they run and what they can reach.
 *
 *   bridge — a local Node process running the Claude Agent SDK. Uses your
 *            existing Claude Code login, so no API key, and every MCP server
 *            you have configured is available, including local stdio ones.
 *
 *   direct — the browser calls the Claude API itself. No process to run and it
 *            deploys as a static site, but it needs an API key in the bundle
 *            and can only use remote HTTP MCP servers.
 */

export const usingBridge = BACKEND === 'bridge'

/** Conversation state lives in the bridge session, so history is only threaded
 *  through on the direct path. */
export async function ask(
  prompt: string,
  history: Msg[],
  handlers: AskHandlers,
  /** Files handed over with this question. Bridge only: they live on its disk. */
  files: string[] = [],
): Promise<{ text: string; tools: string[] }> {
  if (isAndroid) {
    const turn = ++androidTurn
    const route = await chooseAndroidRoute()
    if (turn !== androidTurn) return { text: '', tools: [] }
    if (route.pcUrl && route.pcUrl !== BRIDGE_HTTP_URL) {
      bridge.disconnect()
      selectBridge(route.pcUrl)
    }
    return device.ask(prompt, handlers, files, route)
  }
  return usingBridge
    ? bridge.ask(prompt, handlers, files)
    : direct.ask([...history, { role: 'user', content: prompt }], handlers)
}

let androidTurn = 0
function chooseAndroidRoute() {
  const signal = AbortSignal.timeout(3500)
  return androidRoute(readDeviceSettings(), (pc) => bridgeFetch(`${pc}/health`, { signal }, pc))
}

export async function warm(): Promise<void> {
  if (isAndroid) {
    await chooseAndroidRoute()
    // Let the interface open before a multi-gigabyte model is downloaded.
    return
  }
  if (usingBridge) await bridge.warmBridge()
  // The direct path's SDK comes with its mode, fetched while the interface boots.
  else void direct.load().catch(() => { /* reported by the first turn */ })
}

/** The bridge reports its server list twice — from config on connect, then
 *  with live status once the agent boots — so the HUD subscribes. */
export function watchServers(fn: (servers: string[]) => void): () => void {
  return usingBridge && !isAndroid ? bridge.watchServers(fn) : () => {}
}

/** Blades arrive from `display` and `blade`. Like ui_* commands, this is a bridge capability: the direct path
 *  has no channel for a server to volunteer anything mid-turn. */
export function watchBlades(fn: (blade: Blade) => void): () => void {
  return usingBridge && !isAndroid ? bridge.watchBlades(fn) : () => {}
}

/** Which brain is answering — Claude, or the local model while Claude is out
 *  of reach. Bridge only; the direct path has one brain and no fallback. */
export function watchBrain(fn: (brain: BrainInfo) => void): () => void {
  return usingBridge && !isAndroid ? bridge.watchBrain(fn) : () => {}
}

/**
 * Redressing the interface — theme, reactor, orbiting objects, effects — is a
 * bridge capability, like blades. The `ui_*` tools live in an in-process MCP
 * server inside the bridge and push straight down the open socket, mid-turn.
 * The direct path has no such channel: the browser talks to the Messages API
 * over one-shot HTTPS requests and gets back an answer, with nowhere for a
 * server to volunteer anything. On that backend this watcher simply never
 * fires and the interface stays exactly as it ships.
 */
export function watchUi(fn: (op: string, args: any) => void): () => void {
  return usingBridge && !isAndroid ? bridge.watchUi(fn) : () => {}
}

/**
 * The one thing the bridge asks US for.
 *
 * Every other channel here is the bridge volunteering something mid-turn. A
 * camera frame is the exception — the hardware is in the browser and the model
 * is in the bridge — so this handler answers a request rather than receiving a
 * push. Bridge-only for the same reason as the rest: the direct path is one-shot
 * HTTPS, with nowhere for a request to arrive.
 */
export function watchCapture(
  fn: (req: bridge.CaptureRequest) => Promise<bridge.CaptureResult>,
): () => void {
  return usingBridge && !isAndroid ? bridge.watchCapture(fn) : () => {}
}

/** The player, for the same reason: the sound is here, the model is there. */
export function watchMusic(fn: (op: Record<string, unknown>) => Promise<string>): () => void {
  return usingBridge && !isAndroid ? bridge.watchMusic(fn) : () => {}
}

/**
 * Barge-in. Stops the answer on both paths and settles whatever `ask()` call
 * is outstanding, so the caller's await always returns — on the bridge by
 * interrupting the agent and resolving with the text so far, on the direct
 * path by aborting the stream so the model stops generating and billing.
 */
export function cancel(): void {
  androidTurn++
  if (isAndroid) device.cancel()
  if (usingBridge) bridge.cancel()
  else direct.cancel()
}

/**
 * Whether the brain is reachable right now.
 *
 * Only meaningful on the bridge, where a live socket is the session. The direct
 * path holds no connection between turns — each one is its own HTTPS request —
 * so there is nothing that can be down until you try it.
 */
export function isConnected(): boolean {
  return isAndroid ? true : usingBridge ? bridge.isConnected() : true
}

/**
 * Connection state, for the UI.
 *
 * Completed exchanges are restored after a drop. The direct path has no
 * connection to lose and emits no connection events.
 */
export function watchConnection(
  fn: (state: bridge.ConnectionState) => void,
): () => void {
  return usingBridge && !isAndroid ? bridge.watchConnection(fn) : () => {}
}

/** Labels for the HUD's SYSTEMS rail. */
export function connectedLabels(): string[] {
  if (isAndroid) return ['Fichiers Android', 'Mémoire Android']
  return usingBridge ? bridge.bridgeServers() : direct.connectedLabels()
}
