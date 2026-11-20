import type { ChatMessage, ChatChunk } from './agent-loop.mjs'
export function remoteChat(fetcher: (input: string, init?: RequestInit) => Promise<Response>, url: string, messages: ChatMessage[], tools: unknown[], signal?: AbortSignal, trace?: Record<string, string>): AsyncGenerator<ChatChunk>
export const INFERENCE_MAX_BYTES: number
export const INFERENCE_MAX_MESSAGES: number
export const INFERENCE_MAX_IMAGES: number
