import { homedir } from 'node:os'
import { localTools } from './local-tools.mjs'

/** Reuse the PC's file tools and policy; Android keeps its own agent loop. */
export function pcTools({ allowWrites = false, cwd, roots }) {
  const names = new Set(['list_files', 'read_file', 'write_file', 'move_file', 'open'])
  const tools = localTools({ allowWrites, cwd, roots }).filter((tool) => names.has(tool.name))
  return {
    manifest: {
      home: homedir(), platform: process.platform, roots, allowWrites,
      tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    },
    async run({ name, args }, signal) {
      signal?.throwIfAborted()
      const tool = tools.find((tool) => tool.name === name)
      if (!tool) throw new Error('PC tool unavailable; check write access on the PC')
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid PC tool arguments')
      return tool.run(args, { signal })
    },
  }
}
