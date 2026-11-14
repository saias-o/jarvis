export type Tool = { name: string; description: string; parameters: object; run: (args: Record<string, any>, options: { signal?: AbortSignal }) => unknown }
export type ChatMessage = { role: string; content: string; tool_name?: string; tool_calls?: unknown[] }
export type ChatChunk = { message?: { content?: string; tool_calls?: unknown[] } }
export function agentTurn(text: string, options: {
  chat: (messages: ChatMessage[], tools: unknown[], signal?: AbortSignal) => AsyncIterable<ChatChunk>
  system?: string; history?: Array<{ user: string; jarvis: string; messages?: ChatMessage[] }>; tools?: Tool[]
  images?: string[]; signal?: AbortSignal; onText?: (text: string) => void
  onTool?: (name: string) => void; onMessages?: (messages: ChatMessage[]) => void; maxSteps?: number
}): Promise<string>
