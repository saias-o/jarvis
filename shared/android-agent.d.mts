import type { Tool } from './agent-loop.mjs'
export type WebHttp = (request: { url: string; method: string; headers: Record<string, string>; data?: unknown }) =>
  Promise<{ status: number; headers?: Record<string, string>; data: unknown }>
export function androidTools(files: {
  status(): Promise<{ root: string; inbox: string; granted: boolean }>
  readMemory(): Promise<{ text: string }>
  run(options: { name: string; args: Record<string, unknown> }): Promise<{ result: string }>
}, platform?: {
  /** Puts a blade on the interface; an image blade's url is a PC path or a web address. */
  show?: (blade: { id: string; title: string; kind: 'markup' | 'image'; html?: string; url?: string; size: 'compact' | 'full'; hold: 'turn' }) => unknown
  /** One exchange, redirects not followed. */
  http?: WebHttp
  /** The thinking model's whole context in bytes, when it is small. */
  context?: number
}): Promise<{ tools: Tool[]; system: string }>
