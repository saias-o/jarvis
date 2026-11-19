import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { UI_TOOLS } from '../shared/ui-tools.mjs'
import { sdkDeviceTools } from './device-server.mjs'

/**
 * Claude's MCP view of the `ui_*` tools.
 *
 * The tools themselves are the shared catalogue's (shared/ui-tools.mjs), the
 * same entries the local model and the phone run. This keeps the server name,
 * so tool names (mcp__jarvis_ui__*) and the code that names them are unchanged.
 *
 * @param {Array<{ name: string }>} catalogue  A device catalogue built with a `ui` primitive.
 */
export function uiServer(catalogue) {
  return createSdkMcpServer({
    name: 'jarvis_ui',
    version: '1.0.0',
    instructions:
      'JARVIS\'s control of his own interface — colour, reactor, orbiting ' +
      'images, chrome, effects. Change it when the change carries meaning, ' +
      'and put it back afterwards with ui_reset.',
    // Behind tool search it would never occur to the model that the interface
    // is something it can touch.
    alwaysLoad: true,
    tools: sdkDeviceTools(catalogue.filter((entry) => UI_TOOLS.has(entry.name))),
  })
}
