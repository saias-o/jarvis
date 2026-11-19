import type { ChatMessage } from './agent-loop.mjs'
export type Exchange = { id?: string; user: string; jarvis: string; messages?: ChatMessage[] }
export function excerpt(value: string, limit: number): string
export const UNCONFIRMED_RESULT: string
export function retainedHistory(raw: unknown, maxBytes?: number): Exchange[]
export function appendExchange(history: Exchange[], exchange: Exchange): Exchange[]
