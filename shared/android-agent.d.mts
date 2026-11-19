import type { ChatChunk, ChatMessage, Tool } from './agent-loop.mjs'
import type { WebHttp } from './web-tools.mjs'
export type AndroidRoute = { inference: 'pc' | 'device'; pcUrl: string | null }
export function androidRoute(settings: { mode: 'auto' | 'pc' | 'device'; pcs: string[] }, probe: (url: string) => Promise<Response>): Promise<AndroidRoute>
type Catalogue = { tools: Tool[]; system: string }
type PhoneCatalogue = Catalogue & {
  /** Device facts of the phone, for a prompt composed per tool group. */
  facts: string
  /** The prompt for the tools offered; `small` keeps it within on-device Gemma's window. */
  compose(offered?: Tool[], hosts?: string[], small?: boolean): string
}
export type AndroidCatalogue = Catalogue & {
  offer(specs: unknown[], local: boolean): unknown[]
  updatePc(available: Catalogue): void
  localSystem(): string
}
export function androidCatalogue(phone: PhoneCatalogue, pc: Catalogue): AndroidCatalogue
type Chat = (messages: ChatMessage[], tools: unknown[], signal?: AbortSignal) => AsyncIterable<ChatChunk>
export function androidChat(options: {
  inference: 'pc' | 'device'
  catalogue: AndroidCatalogue
  remote: Chat
  local: Chat
  discover(): Promise<Catalogue>
  canFallback?: () => boolean
  onFallback?: (reason: unknown) => unknown
}): { chat: (messages: ChatMessage[], tools: unknown[], signal?: AbortSignal) => AsyncGenerator<ChatChunk>; source(): 'pc' | 'device' }
export function recentFacts(text: string, maxBytes: number): string
export function androidTools(files: {
  status(): Promise<{ root: string; inbox: string; granted: boolean }>
  readMemory(): Promise<{ text: string }>
  writeMemory?(options: { text: string }): Promise<unknown>
  run(options: { name: string; args: Record<string, unknown> }): Promise<{ result: string }>
}, platform?: {
  /** Puts a blade on the interface; an image blade's url is a PC path or a web address. */
  show?: (blade: { id: string; title: string; kind: 'markup' | 'image'; html?: string; url?: string; size: 'compact' | 'full'; hold: 'turn' }) => unknown
  http?: WebHttp
  /** The thinking model's whole context in bytes, when it is small. */
  context?: number
  smallContext?: () => boolean
}): Promise<PhoneCatalogue>
