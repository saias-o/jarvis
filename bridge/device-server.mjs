/** Protocol adapter only: Claude receives the very same executable catalogue. */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export function sdkDeviceTools(catalogue) {
  return catalogue.map((entry) => tool(entry.name, entry.description,
    z.fromJSONSchema(entry.parameters).shape,
    async (args, extra) => {
      try {
        const result = await entry.run(args, { signal: extra?.signal })
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] }
      }
    }))
}

export function deviceServer(catalogue) {
  return createSdkMcpServer({ name: 'jarvis-device', version: '1.0.0', tools: sdkDeviceTools(catalogue) })
}
