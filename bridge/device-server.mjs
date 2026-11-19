/** Protocol adapter only: Claude receives the very same executable catalogue. */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * The catalogue's JSON schema as the SDK's zod shape. Forgiving entries (screen
 * and interface tools) keep their types for the model, but a malformed value
 * becomes an absent one, which the tool then ignores or refuses with a reason.
 */
function shape(entry) {
  const fields = z.fromJSONSchema(entry.parameters).shape
  if (!entry.forgiving) return fields
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.optional().catch(undefined)]))
}

export function sdkDeviceTools(catalogue) {
  // A large model also reads an entry's guide: when the capability is worth using.
  return catalogue.map((entry) => tool(entry.name, entry.guide ? `${entry.description}\n\n${entry.guide}` : entry.description,
    shape(entry),
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
