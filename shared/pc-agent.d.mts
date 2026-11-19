import type { Tool } from './agent-loop.mjs'
export function pcTools(fetcher: (input: string, init?: RequestInit) => Promise<Response>, url: string,
  files: { upload(options: { path: string; url: string; token: string }): Promise<{ path: string }> },
  token: () => string, signal?: AbortSignal, trace?: Record<string, string>, smallContext?: () => boolean): Promise<{ tools: Tool[]; system: string }>
