import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pcTools as serverTools } from '../bridge/pc-tools.mjs'
import { pcTools } from '../shared/pc-agent.mjs'
import { androidTools } from '../shared/android-agent.mjs'
import { createInference, MAX_TOOLS } from '../bridge/inference.mjs'
import { agentTurn } from '../shared/agent-loop.mjs'
import { remoteChat } from '../shared/remote-chat.mjs'

let dir, child, url
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-pc-transfer-'))
  child = spawn(process.execPath, [fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))], {
    env: { ...process.env, JARVIS_BRIDGE_PORT: '0', JARVIS_REMOTE_PORT: '',
      JARVIS_WORKSPACE: join(dir, 'workspace'), JARVIS_INBOX: '',
      JARVIS_FILE_ROOTS: dir, JARVIS_ALLOW_WRITES: '1', JARVIS_BRAIN: 'claude' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  url = await new Promise((resolve, reject) => {
    let log = ''
    const timer = setTimeout(() => reject(new Error(log || 'Bridge startup timeout')), 15_000)
    const data = (chunk) => {
      log += chunk
      const match = /bridge listening on ws:\/\/\S+:(\d+)/.exec(log)
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`) }
    }
    child.stdout.on('data', data)
    child.stderr.on('data', data)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Bridge exited ${code}: ${log}`)) })
  })
})
after(async () => {
  if (child && child.exitCode === null) {
    const stopped = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await stopped
  }
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('Android agent transfers an attachment through existing upload, moves it on the PC and verifies the bytes', async () => {
  const phonePath = '/data/user/0/dev.jarvis.app/files/inbox/photo.png'
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 42, 13, 10])
  const images = join(dir, 'sandr', 'Images')
  const target = join(images, 'photo.png')
  await mkdir(images, { recursive: true })
  let uploads = 0
  const files = {
    status: async () => ({ root: '/storage/emulated/0', inbox: '/data/user/0/dev.jarvis.app/files/inbox', granted: true }),
    readMemory: async () => ({ text: '' }),
    run: async () => { throw new Error('PC paths must never reach the Android file tools') },
    upload: async (input) => {
      assert.deepEqual(input, { path: phonePath, url, token: 'paired-token' })
      uploads++
      const result = await fetch(`${url}/upload?name=photo.png`, { method: 'POST', body: bytes })
      assert.equal(result.status, 200)
      return result.json()
    },
  }
  const phone = await androidTools(files, { show: () => {}, http: async () => ({}) })
  const pc = await pcTools(fetch, url, files, () => 'paired-token')
  assert.ok(phone.tools.length + pc.tools.length <= MAX_TOOLS, 'The combined Android tool manifest must fit inference validation')
  const steps = []
  let received
  const infer = createInference({ query: ({ prompt, options }) => {
    const input = JSON.parse(prompt)
    assert.deepEqual(options.tools, []) // Inference itself still has no desktop tools.
    const last = input.messages.at(-1)
    let answer
    switch (steps.length) {
      case 0:
        assert.ok(input.available_phone_tools.some((t) => t.function.name === 'upload_to_pc'))
        assert.ok(input.available_phone_tools.some((t) => t.function.name === 'pc_move_file'))
        assert.match(input.messages[0].content, /Écritures PC : autorisées/)
        answer = { content: '', calls: [{ name: 'pc_list_files', arguments: { folder: images } }] }
        break
      case 1:
        assert.equal(last.tool_name, 'pc_list_files')
        answer = { content: '', calls: [{ name: 'upload_to_pc', arguments: { path: phonePath } }] }
        break
      case 2:
        received = JSON.parse(last.content).path
        answer = { content: '', calls: [{ name: 'pc_move_file', arguments: { from: received, to: target } }] }
        break
      case 3:
        assert.equal(last.content, 'Moved.')
        answer = { content: '', calls: [{ name: 'pc_list_files', arguments: { folder: images } }] }
        break
      default:
        assert.match(last.content, /photo\.png \(9 bytes\)/)
        answer = { content: 'Le fichier est dans votre dossier Images sur le PC.', calls: [] }
    }
    steps.push(answer)
    return (async function* () { yield { type: 'result', subtype: 'success', structured_output: answer } })()
  } })
  const text = await agentTurn(`Mets cette pièce jointe dans sandr/Images sur le PC : ${phonePath}`, {
    tools: [...phone.tools, ...pc.tools], system: `${phone.system}\n${pc.system}`, maxSteps: 8,
    chat: (messages, tools, signal) => remoteChat(async (_url, init) => Response.json(await infer(JSON.parse(init.body), signal)), url, messages, tools, signal),
  })
  assert.equal(text, 'Le fichier est dans votre dossier Images sur le PC.')
  assert.equal(uploads, 1)
  assert.deepEqual(await readFile(target), bytes)
  await assert.rejects(readFile(received), { code: 'ENOENT' })
  assert.equal(steps.length, 5)
})

test('PC execution refuses unoffered tools and credential files', async () => {
  for (const input of [
    { name: 'Bash', args: { command: 'echo no' } },
    { name: 'write_file', args: { path: join(dir, '.env'), content: 'no' } },
    { name: 'read_file', args: null },
  ]) {
    const res = await fetch(`${url}/pc-tools`, { method: 'POST', body: JSON.stringify(input) })
    assert.equal(res.status, 403)
  }
})

test('read-only PC advertises no writes and execution cannot bypass this or the file roots', async () => {
  const roots = [join(dir, 'workspace')]
  const readonly = serverTools({ allowWrites: false, cwd: roots[0], roots })
  assert.deepEqual(readonly.manifest.tools.map((t) => t.name), ['list_files', 'read_file'])
  await assert.rejects(readonly.run({ name: 'run_command', args: { command: 'echo no' } }), /write access/)
  await assert.rejects(readonly.run({ name: 'move_file', args: { from: 'a', to: 'b' } }), /write access/)
  await assert.rejects(readonly.run({ name: 'read_file', args: { path: join(dir, 'outside.txt') } }), /outside/)
  const writable = serverTools({ allowWrites: true, cwd: roots[0], roots })
  await assert.rejects(writable.run({ name: 'write_file', args: { path: join(dir, 'outside.txt'), content: 'no' } }), /outside/)
})

test('Android retains the existing PC command capability when writes are enabled', async () => {
  const pc = await pcTools(fetch, url, { upload: async () => ({ path: '' }) }, () => '')
  const command = pc.tools.find((tool) => tool.name === 'pc_run_command')
  assert.ok(command, 'The Android path must not silently reduce the full PC agent to file tools')
  assert.match(pc.system, /capture de l’écran du PC/)
  const output = await command.run({ command: process.platform === 'win32'
    ? "Write-Output 'pc-capability-restored'" : "printf 'pc-capability-restored'" })
  assert.match(output, /pc-capability-restored/)
})

test('existing Android show tool displays PC images as well as text', async () => {
  let shown
  const phone = await androidTools({
    status: async () => ({ root: '/storage/emulated/0', inbox: '/phone/inbox', granted: true }),
    readMemory: async () => ({ text: '' }),
  }, { show: (blade) => { shown = blade } })
  const show = phone.tools.find((tool) => tool.name === 'show')
  assert.equal(await show.run({ title: 'Écran du PC', image: 'C:/workspace/screen.png' }), 'On screen.')
  assert.deepEqual({ ...shown, id: '' }, { id: '', title: 'Écran du PC', hold: 'turn', kind: 'image', url: 'C:/workspace/screen.png', size: 'full' })
  await assert.rejects(show.run({ title: 'Empty' }), /text or an image/)
})

test('PC context exposes actual redirected user folders only when their paths are shared', async () => {
  const pictures = join(dir, 'OneDrive', 'Pictures')
  const workspace = join(dir, 'workspace')
  await mkdir(pictures, { recursive: true })
  const pc = serverTools({ cwd: workspace, roots: [workspace, pictures],
    folders: { MyPictures: pictures, MyDocuments: join(dir, 'not-shared'), Empty: '' } })
  assert.deepEqual(pc.manifest.folders, { MyPictures: pictures })
  const infer = createInference({ host: pc.manifest, query: ({ prompt, options }) => {
    assert.equal(JSON.parse(prompt).host.folders.MyPictures, pictures)
    assert.match(options.systemPrompt, /OneDrive redirections/)
    return (async function* () { yield { type: 'result', subtype: 'success', structured_output: { content: '', calls: [] } } })()
  } })
  await infer({ messages: [{ role: 'user', content: 'Range le fichier dans Images.' }], tools: [] })
})

test('moving a PC attachment never replaces an existing destination', async () => {
  const from = join(dir, 'source.txt'), to = join(dir, 'existing.txt')
  await writeFile(from, 'source')
  await writeFile(to, 'original')
  const res = await fetch(`${url}/pc-tools`, { method: 'POST', body: JSON.stringify({ name: 'move_file', args: { from, to } }) })
  assert.equal(res.status, 403)
  assert.equal(await readFile(to, 'utf8'), 'original')
  assert.equal(await readFile(from, 'utf8'), 'source')
})

test('cancelled transfers never upload and old PC servers keep Android tools usable', async () => {
  let uploads = 0
  const files = { upload: async () => { uploads++; return { path: 'late' } } }
  const pc = await pcTools(fetch, url, files, () => '')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(pc.tools.find((t) => t.name === 'upload_to_pc').run({ path: 'phone' }, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(uploads, 0)
  const old = await pcTools(async () => new Response('', { status: 404 }), url, files, () => '')
  assert.deepEqual(old.tools, [])
  assert.match(old.system, /mettez à jour/)
})
