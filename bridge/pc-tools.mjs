import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { localTools } from './local-tools.mjs'
import { pathProblem } from './policy.mjs'

let userFolders
function knownFolders() {
  if (userFolders) return userFolders
  userFolders = {}
  if (process.platform === 'win32') {
    try {
      // Ask Windows: localized names and OneDrive redirections are not paths
      // the LLM should guess. No user input is interpolated into this command.
      userFolders = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $folders = @{}; foreach ($name in @('Desktop','MyDocuments','MyPictures','MyMusic','MyVideos')) { $folders[$name] = [Environment]::GetFolderPath($name) }; $folders | ConvertTo-Json -Compress",
      ], { encoding: 'utf8', timeout: 5000, windowsHide: true }))
    } catch {
      // Folder discovery is context, not a prerequisite for file tools.
    }
  }
  return userFolders
}

/** Reuse the PC's file tools and policy; Android keeps its own agent loop. */
export function pcTools({ allowWrites = false, shell = allowWrites, cwd, roots, folders = knownFolders() }) {
  const names = new Set(['list_files', 'read_file', 'write_file', 'move_file', 'open', 'run_command'])
  // The full desktop agent already has a shell when actions are enabled.
  // Preserve that capability for Android callers instead of reducing the PC
  // to a file server. Reuse the existing executor and write gate.
  const options = { allowWrites, cwd, roots, shell }
  const tools = localTools(options).filter((tool) => names.has(tool.name))
  let smallPages
  return {
    manifest: {
      home: homedir(), platform: process.platform, roots, allowWrites,
      folders: Object.fromEntries(Object.entries(folders).filter(([, path]) =>
        typeof path === 'string' && path && !pathProblem(path, { cwd, roots }))),
      tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    },
    async run({ name, args, compact }, signal) {
      signal?.throwIfAborted()
      if (!names.has(name)) throw new Error('PC tool unavailable; check write access on the PC')
      if (compact === true) smallPages ??= localTools({ ...options, page: 600 })
      const tool = (compact === true ? smallPages : tools).find((tool) => tool.name === name)
      if (!tool) throw new Error('PC tool unavailable; check write access on the PC')
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid PC tool arguments')
      return tool.run(args, { signal })
    },
  }
}
