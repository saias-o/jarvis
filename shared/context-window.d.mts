import type { ChatMessage, ChatChunk } from './agent-loop.mjs'
export function fitContext(messages: ChatMessage[], tools: unknown[], maxBytes?: number): ChatMessage[]
export function contextOverflow(error: unknown): boolean
export function boundedChat(
  chat: (messages: ChatMessage[], tools: unknown[], signal?: AbortSignal) => AsyncIterable<ChatChunk>,
  messages: ChatMessage[], tools: unknown[], signal?: AbortSignal,
): AsyncGenerator<ChatChunk>
