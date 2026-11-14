/** Prepare one persistent APK key without installing a JDK on this machine. */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const folder = resolve('.android-signing')
const key = join(folder, 'jarvis.p12')
const credentials = join(folder, 'credentials.json')
const openssl = process.env.JARVIS_OPENSSL || (process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error || result.status}`)
  return result.stdout
}

mkdirSync(folder, { recursive: true, mode: 0o700 })
if (!existsSync(key)) {
  if (existsSync(credentials)) throw new Error('Signing credentials already exist without their key; restore the backup before continuing.')
  const password = randomBytes(32).toString('hex')
  const env = { ...process.env, JARVIS_SIGNING_PASSWORD: password }
  run(openssl, ['req', '-x509', '-newkey', 'rsa:3072', '-keyout', join(folder, 'private.pem'),
    '-out', join(folder, 'certificate.pem'), '-days', '10000', '-subj', '/CN=JARVIS Android/',
    '-passout', 'env:JARVIS_SIGNING_PASSWORD'], { env })
  run(openssl, ['pkcs12', '-export', '-out', key, '-inkey', join(folder, 'private.pem'),
    '-in', join(folder, 'certificate.pem'), '-name', 'jarvis',
    '-passin', 'env:JARVIS_SIGNING_PASSWORD', '-passout', 'env:JARVIS_SIGNING_PASSWORD'], { env })
  writeFileSync(credentials, JSON.stringify({ password, alias: 'jarvis' }), { mode: 0o600 })
}

if (process.argv.includes('--github')) {
  const repo = process.argv.find((a) => a.startsWith('--repo='))?.slice(7)
  if (!repo) throw new Error('Pass the explicit destination: --repo=OWNER/REPO')
  const saved = JSON.parse(readFileSync(credentials, 'utf8'))
  const secrets = {
    ANDROID_KEYSTORE_BASE64: readFileSync(key).toString('base64'),
    ANDROID_KEYSTORE_PASSWORD: saved.password,
    ANDROID_KEY_ALIAS: saved.alias,
    ANDROID_KEY_PASSWORD: saved.password,
  }
  for (const [name, value] of Object.entries(secrets)) run('gh', ['secret', 'set', name, '--repo', repo], { input: value })
  console.log(`Four Android signing secrets configured in ${repo}.`)
}
console.log(`Persistent APK signing key: ${key}. Back up the entire .android-signing folder privately.`)
