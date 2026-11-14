/**
 * Start JARVIS, with remote access, when you sign in to Windows.
 *
 *   npm run remote:autostart              turn it on
 *   npm run remote:autostart -- --writes  …and let JARVIS act, not only look
 *   npm run remote:autostart -- --off     turn it off again
 *
 * A phone is only as useful as the computer behind it, and a computer that
 * restarted overnight for an update is one where nobody typed `npm run remote`.
 * This puts one small file in your own Startup folder — the per-user one, no
 * administrator rights, nothing in the registry — and deleting that file is
 * the whole of undoing it.
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32' || !process.env.APPDATA) {
  console.error('  Autostart is only set up for Windows. On other systems, add `npm run remote` to your login items.')
  process.exit(1)
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const file = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'JARVIS.cmd')

if (process.argv.includes('--off')) {
  if (existsSync(file)) rmSync(file)
  console.log('  JARVIS no longer starts when you sign in.')
  process.exit(0)
}

const command = process.argv.includes('--writes') ? 'npm run remote:writes' : 'npm run remote'

writeFileSync(
  file,
  [
    '@echo off',
    'rem Starts JARVIS with remote access at sign-in.',
    'rem Created by "npm run remote:autostart"; remove with "npm run remote:autostart -- --off".',
    `cd /d "${root}"`,
    // Minimised, in its own window, so the log is there when you want it.
    `start "JARVIS" /min cmd /k ${command}`,
    '',
  ].join('\r\n'),
)

console.log(`  JARVIS will start (${command}) each time you sign in to Windows.`)
console.log(`  The file that does it: ${file}`)
console.log('  Undo with: npm run remote:autostart -- --off')
