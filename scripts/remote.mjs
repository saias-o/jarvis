/**
 * What `npm run remote` adds to `npm start`: JARVIS reachable from your phone.
 *
 * Nothing here opens the machine to the internet. The bridge grows a second
 * port that still listens on loopback only, and Tailscale — a private network
 * between your own devices — carries it to the phone over real HTTPS, which a
 * phone's browser insists on before it will hand a page the microphone.
 *
 * Four jobs, in the order start.mjs calls them:
 *   findTailnet   — is Tailscale installed, signed in, and what is this
 *                   machine called on it?
 *   buildFace     — the phone gets the built interface, served by the bridge,
 *                   so it is rebuilt whenever the source is newer.
 *   publish       — `tailscale serve`, pointing the tailnet name at that port.
 *   keepAwake     — a sleeping computer answers nobody; hold it awake for as
 *                   long as this process lives, and not a second longer.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

export const REMOTE_PORT = Number(process.env.JARVIS_REMOTE_PORT ?? 8788)

const TAILSCALE_PATHS = [
  'tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
]

function tailscale(args) {
  for (const bin of TAILSCALE_PATHS) {
    const res = spawnSync(bin, args, { encoding: 'utf8', timeout: 20_000 })
    if (res.error?.code === 'ENOENT') continue
    return { bin, ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() }
  }
  return null
}

/** Resolves { name, login } — this machine's tailnet name and account — or { problem }. */
export function findTailnet() {
  const status = tailscale(['status', '--json'])
  if (!status) {
    return {
      problem:
        'Tailscale is not installed. Install it on this computer and on your phone\n' +
        '    (https://tailscale.com/download), sign in to the same account on both,\n' +
        '    then run this again.',
    }
  }
  let info
  try {
    info = JSON.parse(status.out)
  } catch {
    return { problem: `Tailscale did not answer: ${status.out.split('\n')[0]}` }
  }
  if (info.BackendState !== 'Running') {
    return {
      problem: `Tailscale is installed but not connected (${info.BackendState}). Open it and sign in.`,
    }
  }
  const name = String(info.Self?.DNSName ?? '').replace(/\.$/, '')
  if (!name) {
    return {
      problem:
        'This machine has no tailnet name. Turn on MagicDNS in the Tailscale admin\n' +
        '    console (https://login.tailscale.com/admin/dns).',
    }
  }
  // The account this machine is signed in with. The bridge lets in only
  // requests the tailnet attributes to it — see userAllowed in bridge/remote.mjs.
  const login = String(info.User?.[info.Self?.UserID]?.LoginName ?? '')
  return { name, login }
}

/** Point https://<tailnet name> at the bridge's remote port. */
export function publish() {
  const res = tailscale(['serve', '--bg', '--https=443', `http://127.0.0.1:${REMOTE_PORT}`])
  if (res?.ok) return { ok: true }
  return {
    ok: false,
    // Tailscale's own words are the useful ones here: when HTTPS certificates
    // are not enabled for the tailnet it prints the link that enables them.
    problem: res?.out || 'tailscale serve failed',
  }
}

/** Take the tailnet name back down. */
export function unpublish() {
  const res = tailscale(['serve', '--https=443', 'off'])
  return res?.ok ?? false
}

const newest = (path) => {
  if (!existsSync(path)) return 0
  const info = statSync(path)
  if (!info.isDirectory()) return info.mtimeMs
  let latest = 0
  for (const entry of readdirSync(path)) {
    // The hand-tracking runtime is 34 MB of files that never change.
    if (entry === 'mediapipe') continue
    latest = Math.max(latest, newest(join(path, entry)))
  }
  return latest
}

/** Build the interface if anything it is made from is newer than the build. */
export function buildFace() {
  const built = existsSync('dist/index.html') ? statSync('dist/index.html').mtimeMs : 0
  const sources = ['src', 'public', 'index.html', 'vite.config.ts', 'package.json', '.env.local']
  if (built && sources.every((s) => newest(s) <= built)) return { ok: true, fresh: true }

  console.log('  building the interface for the phone…')
  const res = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'], {
    stdio: 'inherit',
  })
  return { ok: res.status === 0, fresh: false }
}

/**
 * Hold the machine awake while JARVIS is reachable.
 *
 * A request to the operating system, not a change to its settings: Windows and
 * macOS both drop it the moment the asking process exits, so the power plan is
 * exactly as it was. The Windows helper watches this process's id and leaves
 * with it, because a terminal closed by its window button never gets to run
 * the shutdown below. It does not stop a laptop sleeping when the lid closes.
 */
export function keepAwake() {
  if (process.platform === 'win32') {
    const script =
      "$k = Add-Type -PassThru -Name Power -Namespace Jarvis -MemberDefinition " +
      "'[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; " +
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
      `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) ` +
      '{ [void]$k::SetThreadExecutionState(2147483649); Start-Sleep -Seconds 20 }'
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
    })
  }
  if (process.platform === 'darwin') {
    return spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
  }
  return null
}
