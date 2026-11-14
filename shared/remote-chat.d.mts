import type { ChatMessage, ChatChunk } from './agent-loop.mjs'
export function remoteChat(fetcher: (input: string, init?: RequestInit) => Promise<Response>, url: string, messages: ChatMessage[], tools: unknown[], signal?: AbortSignal): AsyncGenerator<ChatChunk>
