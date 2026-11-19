/** Start an installed Ollama alongside JARVIS; never download on app launch. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { brainMode } from '../bridge/router.mjs'
import { localConfig } from '../bridge/local.mjs'

export async function startLocalRuntime() {
  if (brainMode(process.env.JARVIS_BRAIN) === 'claude') return null
  const { urls } = localConfig()
  const ready = async (url) => {
    try {
      const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(800) })
      return response.ok && Array.isArray((await response.json()).models)
    } catch { return false }
  }
  for (const url of urls) if (await ready(url)) return null

  // Only start our own local endpoint. A configured server elsewhere belongs
  // to that machine; a running Ollama above also stays owned by its launcher.
  const url = urls.map((raw) => { try { return new URL(raw) } catch { return null } })
    .find((url) => url?.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/')
  if (!url) return null
  const candidates = [
    process.env.JARVIS_OLLAMA_EXECUTABLE?.trim(),
    join(process.cwd(), '.tools', 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama'),
    ...(process.platform === 'win32' ? [join(homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe')] : []),
  ].filter(Boolean)
  const executable = candidates.find((path) => existsSync(path))
  const child = spawn(executable ? resolve(executable) : 'ollama', ['serve'], {
    env: { ...process.env, OLLAMA_HOST: url.host }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const started = await new Promise((resolve) => {
    child.once('spawn', () => resolve(true))
    child.once('error', (err) => {
      console.warn(`[jarvis] cannot start Ollama: ${err.message}`)
      resolve(false)
    })
  })
  if (!started) return null
  const log = (data) => process.stdout.write(`[ollama] ${data}`)
  child.stdout.on('data', log)
  child.stderr.on('data', log)
  child.on('exit', (code) => console.warn(`[jarvis] managed Ollama stopped (${code})`))
  const deadline = Date.now() + 15_000
  while (child.exitCode === null && Date.now() < deadline) {
    if (await ready(url.origin)) {
      console.log(`[jarvis] local runtime ready at ${url.origin}`)
      return child
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  console.warn('[jarvis] Ollama has not become ready yet; the bridge will keep checking its availability.')
  return child
}
