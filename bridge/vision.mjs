import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { CAMERA_TOOLS } from '../shared/camera-tools.mjs'
import { sdkDeviceTools } from './device-server.mjs'

/**
 * Claude's MCP view of the camera: `look` and `watch`.
 *
 * The tools are the shared catalogue's (shared/camera-tools.mjs), the same
 * entries the local model runs, built on this connection's capture request to
 * the browser. The server keeps its name, so tool names (mcp__jarvis_eyes__*)
 * and the policy that allows them are unchanged.
 *
 * @param {Array<{ name: string }>} catalogue  A device catalogue built with a `capture` primitive.
 */
export function visionServer(catalogue) {
  return createSdkMcpServer({
    name: 'jarvis_eyes',
    version: '1.0.0',
    instructions:
      "The camera on the user's machine, pointed at them. Use it when they ask " +
      'you to look at something. It is not a sensor to poll; it is an act.',
    // Behind tool search, "look at me" would find nothing and become an apology.
    alwaysLoad: true,
    tools: sdkDeviceTools(catalogue.filter((entry) => CAMERA_TOOLS.has(entry.name))),
  })
}
