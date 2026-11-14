import type { Tool } from './agent-loop.mjs'
export function androidTools(files: {
  status(): Promise<{ root: string; inbox: string; granted: boolean }>
  readMemory(): Promise<{ text: string }>
  run(options: { name: string; args: Record<string, unknown> }): Promise<{ result: string }>
}, show: (title: unknown, text: unknown) => unknown): Promise<{ tools: Tool[]; system: string }>
