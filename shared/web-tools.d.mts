import type { Tool } from './agent-loop.mjs'
/** One exchange, redirects not followed. A `binary` request is answered with the body in base64. */
export type WebHttp = (request: { url: string; method: string; headers: Record<string, string>; data?: unknown; binary?: boolean }) =>
  Promise<{ status: number; headers?: Record<string, string>; data: unknown }>
export function htmlToText(html: string): string
export function webImage(http: WebHttp, url: string, options?: { signal?: AbortSignal; maxBytes?: number }): Promise<string>
export function webTools(http: WebHttp, options?: { limit?: number }): Tool[]
