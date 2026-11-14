import type { ChatMessage, ChatChunk } from './agent-loop.mjs'
export const LOCAL_CONTEXT_BYTES: number
export function fitContext(messages: ChatMessage[], tools: unknown[], maxBytes?: number): ChatMessage[]
export function contextOverflow(error: unknown): boolean
export function boundedChat(
  chat: (messages: ChatMessage[], tools: unknown[], signal?: AbortSignal) => AsyncIterable<ChatChunk>,
  messages: ChatMessage[], tools: unknown[], signal?: AbortSignal,
): AsyncGenerator<ChatChunk>
