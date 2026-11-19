import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { DISPLAY_TOOLS } from '../shared/display-tools.mjs'
import { sdkDeviceTools } from './device-server.mjs'

/**
 * Claude's MCP view of the screen tools: `display`, `blade` and `probe_url`.
 *
 * The tools themselves are the shared catalogue's (shared/display-tools.mjs),
 * the same entries the local model and the phone run, with their design system
 * as the guide Claude reads. This keeps the server name, so tool names
 * (mcp__jarvis__display, ...) and the code that names them are unchanged.
 *
 * @param {Array<{ name: string }>} catalogue  A device catalogue built with a `show` primitive.
 */
export function displayServer(catalogue) {
  return createSdkMcpServer({
    name: 'jarvis',
    version: '1.0.0',
    instructions:
      'The JARVIS heads-up display. Use `display` to put content on screen ' +
      'alongside what you say.',
    // Never defer this behind tool search: if the model has to go looking for
    // it, it won't occur to it to show anything.
    alwaysLoad: true,
    tools: sdkDeviceTools(catalogue.filter((entry) => DISPLAY_TOOLS.has(entry.name))),
  })
}
