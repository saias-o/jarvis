import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pcTools as serverTools } from '../bridge/pc-tools.mjs'
import { pcTools } from '../shared/pc-agent.mjs'
import { androidCatalogue, androidChat, androidRoute, androidTools, recentFacts } from '../shared/android-agent.mjs'
import { boundedChat, fitContext, LOCAL_CONTEXT_BYTES } from '../shared/context-window.mjs'
import { createInference, MAX_TOOLS } from '../bridge/inference.mjs'
import { agentTurn } from '../shared/agent-loop.mjs'
import { remoteChat } from '../shared/remote-chat.mjs'
import { copyExclusive } from '../bridge/move-file.mjs'

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

test('Gemma selects and uses PC tools through the bridge while inference stays on the phone', async () => {
  const calls = []
  const tracked = async (url, init) => {
    calls.push(new URL(url).pathname)
    return fetch(url, init)
  }
  const route = await androidRoute({ mode: 'device', pcs: [url] }, (url) => tracked(url + '/health'))
  assert.deepEqual(route, { inference: 'device', pcUrl: url })
  const input = join(dir, 'local-model.txt'), image = join(dir, 'local-model.png')
  await writeFile(input, 'PC result. '.repeat(300))
  const pc = await pcTools(tracked, route.pcUrl, {}, () => '', undefined, undefined, () => true)
  const shown = []
  const phone = await androidTools({
    status: async () => ({ granted: true, root: '/storage/emulated/0', inbox: '/phone/inbox' }),
    readMemory: async () => ({ text: '' }),
  }, { http: () => {}, show: (blade) => shown.push(blade), context: LOCAL_CONTEXT_BYTES })
  const catalogue = androidCatalogue(phone, pc)
  const steps = [
    { name: 'select_device_tools', arguments: { device: 'pc' } },
    { name: 'pc_read_file', arguments: { path: input } },
    { name: 'show', arguments: { image } },
  ]
  let step = 0
  async function* predict(messages, offered) {
    if (step === 0) assert.ok(!offered.some((spec) => spec.function.name === 'pc_read_file'))
    if (step === 2) assert.match(messages.at(-1).content, /more characters; read on with from=600/)
    const proposal = steps[step++]
    if (proposal) {
      assert.ok(offered.some((spec) => spec.function.name === proposal.name))
      yield { message: { tool_calls: [{ function: proposal }] } }
    } else yield { message: { content: 'Done.' } }
  }
  const answer = await agentTurn('Lis sur le PC, puis affiche son image.', {
    tools: catalogue.tools, system: catalogue.localSystem(),
    chat: (messages, specs, signal) => boundedChat(predict, messages.map((m) => m.role === 'system'
      ? { ...m, content: catalogue.localSystem() } : m), catalogue.offer(specs, true), signal),
  })
  assert.equal(answer, 'Done.')
  assert.deepEqual(calls, ['/health', '/pc-tools', '/pc-tools'])
  assert.equal(shown[0].url, image)
  assert.ok(!catalogue.offer(catalogue.tools.map((tool) => ({ function: tool })), false).some((s) => s.function.name === 'select_device_tools'))
  catalogue.updatePc({ tools: [], system: '' })
  const offline = catalogue.offer(catalogue.tools.map((tool) => ({ function: tool })), true)
  assert.deepEqual(offline.map((s) => s.function.name), phone.tools.map((t) => t.name))
})

test('PC discovery respects the chosen inference mode and the configured order', async () => {
  const pcs = ['older', 'newer']
  const probe = async (url) => Response.json(url === 'newer' ? { inference: 'android-v1' } : {})
  assert.deepEqual(await androidRoute({ mode: 'auto', pcs }, probe), { inference: 'pc', pcUrl: 'newer' })
  assert.deepEqual(await androidRoute({ mode: 'device', pcs }, probe), { inference: 'device', pcUrl: 'older' })
  const down = async () => { throw new Error('offline') }
  assert.deepEqual(await androidRoute({ mode: 'auto', pcs }, down), { inference: 'device', pcUrl: null })
  await assert.rejects(androidRoute({ mode: 'pc', pcs }, down), /injoignable/)
  await assert.rejects(androidRoute({ mode: 'pc', pcs }, async () => new Response(null, { status: 401 })), /Code d’accès/)
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
  assert.match(pc.system, /capturer l’écran du PC/)
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

test('HTTP tool validation preserves an existing file and permits explicitly empty text', async () => {
  const path = join(dir, 'validation.txt')
  await writeFile(path, 'original')
  const write = (args) => fetch(`${url}/pc-tools`, { method: 'POST', body: JSON.stringify({ name: 'write_file', args }) })
  for (const args of [{ path }, { path, content: null }, { path, content: 42 }]) {
    const response = await write(args)
    assert.equal(response.ok, false)
    assert.match((await response.json()).error, /content/)
    assert.equal(await readFile(path, 'utf8'), 'original')
  }
  assert.ok((await write({ path, content: '' })).ok)
  assert.equal(await readFile(path, 'utf8'), '')
})

test('two PC moves cannot overwrite the same destination', async () => {
  const to = join(dir, 'winner.txt')
  const payloads = ['first contender', 'second contender']
  const sources = payloads.map((_, index) => join(dir, `contender-${index}.txt`))
  await Promise.all(sources.map((from, i) => writeFile(from, payloads[i])))
  const moves = await Promise.all(sources.map((from) => fetch(`${url}/pc-tools`, {
    method: 'POST', body: JSON.stringify({ name: 'move_file', args: { from, to } }),
  })))
  assert.equal(moves.filter((r) => r.ok).length, 1)
  const winner = moves.findIndex((r) => r.ok)
  assert.equal(await readFile(to, 'utf8'), payloads[winner])
  assert.equal(await readFile(sources[1 - winner], 'utf8'), payloads[1 - winner])
  await assert.rejects(readFile(sources[winner]), { code: 'ENOENT' })
})

test('an interrupted exclusive copy preserves its source and removes its partial destination', async () => {
  const from = join(dir, 'copy-source.txt'), to = join(dir, 'copy-target.txt')
  await writeFile(from, 'original')
  await assert.rejects(copyExclusive(from, to, 0o600, AbortSignal.abort()), { name: 'AbortError' })
  await assert.rejects(readFile(to), { code: 'ENOENT' })
  assert.equal(await readFile(from, 'utf8'), 'original')
  await copyExclusive(from, to, 0o600)
  await assert.rejects(copyExclusive(from, to, 0o600), { code: 'EEXIST' })
  assert.equal(await readFile(to, 'utf8'), 'original')
})

test('an explicitly disabled PC shell is absent from the remote catalogue', async () => {
  const pc = serverTools({ cwd: dir, roots: [dir], folders: {}, allowWrites: true, shell: false })
  assert.equal(pc.manifest.tools.some((tool) => tool.name === 'run_command'), false)
  await assert.rejects(pc.run({ name: 'run_command', args: {} }), /unavailable/)
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

const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length
const specsOf = (tools) => tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }))
const fullMemory = async () => ({ text: '# Memory\n\n' + Array.from({ length: 60 }, (_, i) =>
  `- 2026-11-${String(i % 28 + 1).padStart(2, '0')} : L’utilisateur préfère « Évan », fait n°${i}.`).join('\n') })

test('on-device Gemma reads a PC or phone page in either tool group, with a full memory', async () => {
  const roots = ['Documents', 'Downloads', 'Pictures'].map((name) => join(dir, 'OneDrive', name))
  for (const root of roots) await mkdir(root, { recursive: true })
  const server = serverTools({ allowWrites: true, shell: true, cwd: roots[0], roots,
    folders: { MyDocuments: roots[0], MyPictures: roots[2] } })
  const pc = await pcTools(async () => Response.json(server.manifest), 'http://100.64.0.1:8788', {}, () => '', undefined, undefined, () => true)
  const phone = await androidTools({ status: async () => ({ root: '/storage/emulated/0', inbox: '/data/user/0/dev.jarvis.app/files/inbox', granted: true }),
    readMemory: fullMemory }, { show: () => {}, http: () => {}, context: LOCAL_CONTEXT_BYTES - size(pc.system) - 400 })
  const catalogue = androidCatalogue(phone, pc)
  const select = catalogue.tools.find((tool) => tool.name === 'select_device_tools')
  // The compact PC page is 600 characters; accents make it up to twice as many bytes.
  const page = 'é'.repeat(600) + '\n[4400 more characters; read on with from=600]'
  for (const [device, read] of [['android', 'read_file'], ['pc', 'pc_read_file']]) {
    await select.run({ device })
    const system = catalogue.localSystem()
    const offered = catalogue.offer(specsOf(catalogue.tools), true)
    assert.ok(offered.some((spec) => spec.function.name === read))
    // The newest remembered fact is what the model is given, not the oldest.
    assert.match(system, /fait n°59\./)
    assert.doesNotMatch(system, /fait n°0\./)
    const turn = [
      { role: 'system', content: system },
      { role: 'user', content: 'Lis le rapport trimestriel dans mes documents et résume-moi les trois points principaux, s’il te plaît.' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: read, arguments: { path: join(roots[0], 'rapport trimestriel.txt') } } }] },
      { role: 'tool', tool_name: read, content: page },
    ]
    assert.deepEqual(fitContext(turn, offered), turn, `${device}: ${size(system) + size(offered)} bytes of prompt and schemas`)
  }
  // Without the small window, PC inference keeps a longer memory and every schema.
  assert.ok(size(catalogue.system) > size(catalogue.localSystem()))
})

test('remembered facts keep the newest lines within their budget', () => {
  assert.equal(recentFacts('# Memory\n\n- a\n- b\n- c\n', 100), '- a\n- b\n- c')
  assert.equal(recentFacts('# Memory\n- old fact\n- new fact', 14), '[faits plus anciens omis]\n- new fact')
  assert.equal(recentFacts('', 100), '')
})

test('PC inference failing mid-turn continues on Gemma with the PC tools it still serves, without replaying an action', async () => {
  const target = join(dir, 'fallback.txt')
  await writeFile(target, 'Contenu du PC.')
  const remembered = []
  const phone = await androidTools({
    status: async () => ({ root: '/storage/emulated/0', inbox: '/phone/inbox', granted: true }),
    readMemory: async () => ({ text: '' }),
    run: async ({ name, args }) => { assert.equal(name, 'remember'); remembered.push(args.fact); return { result: 'Remembered.' } },
  }, { show: () => {}, context: LOCAL_CONTEXT_BYTES })
  let source
  const discover = () => pcTools(fetch, url, {}, () => '', undefined, undefined, () => source() === 'device')
  const catalogue = androidCatalogue(phone, await discover())
  let remoteSteps = 0, fallbacks = 0
  const localOffers = []
  const model = androidChat({
    inference: 'pc', catalogue, discover,
    async *remote(_messages, specs) {
      // PC inference sees both devices and no group selector.
      assert.ok(specs.some((spec) => spec.function.name === 'pc_read_file'))
      assert.ok(!specs.some((spec) => spec.function.name === 'select_device_tools'))
      if (remoteSteps++ === 0) { yield { message: { tool_calls: [{ function: { name: 'remember', arguments: { fact: 'Évan range ses rapports sur le PC.' } } }] } }; return }
      throw new Error('inference service crashed')
    },
    async *local(messages, specs) {
      localOffers.push(specs.map((spec) => spec.function.name))
      // The action done before the failure is in the context, not to be repeated.
      assert.ok(messages.some((message) => message.role === 'tool' && message.tool_name === 'remember'))
      const step = localOffers.length
      if (step === 1) yield { message: { tool_calls: [{ function: { name: 'select_device_tools', arguments: { device: 'pc' } } }] } }
      else if (step === 2) yield { message: { tool_calls: [{ function: { name: 'pc_read_file', arguments: { path: target } } }] } }
      else {
        assert.equal(messages.at(-1).content, 'Contenu du PC.')
        yield { message: { content: 'Le fichier dit : Contenu du PC.' } }
      }
    },
    onFallback: () => { fallbacks++ },
  })
  source = model.source
  const answer = await agentTurn('Retiens où je range mes rapports, puis lis fallback.txt sur le PC.', {
    tools: catalogue.tools, system: catalogue.system, chat: model.chat, maxSteps: 8,
  })
  assert.equal(answer, 'Le fichier dit : Contenu du PC.')
  assert.equal(model.source(), 'device')
  assert.deepEqual(remembered, ['Évan range ses rapports sur le PC.'])
  assert.equal(fallbacks, 1)
  assert.ok(localOffers[0].includes('select_device_tools') && !localOffers[0].includes('pc_read_file'))
  assert.ok(localOffers[1].includes('pc_read_file'))
})

test('a fallback with the PC gone offers only the phone, and a manual mode never falls back', async () => {
  const phone = await androidTools({ status: async () => ({ root: '/s', inbox: '/i', granted: true }), readMemory: async () => ({ text: '' }) }, { show: () => {} })
  const pc = await pcTools(fetch, url, {}, () => '')
  /** A model stream that fails before producing anything. */
  const failing = (message) => () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(message)) }) })
  const fail = failing('down')
  const offered = []
  const catalogue = androidCatalogue(phone, pc)
  const model = androidChat({ inference: 'pc', catalogue, remote: fail,
    discover: async () => { throw new Error('unreachable') },
    async *local(_messages, specs) { offered.push(...specs.map((spec) => spec.function.name)); yield { message: { content: 'ok' } } } })
  assert.equal(await agentTurn('Bonjour', { tools: catalogue.tools, system: catalogue.system, chat: model.chat }), 'ok')
  assert.deepEqual(offered, phone.tools.map((tool) => tool.name))
  assert.match(catalogue.localSystem(), /Aucun outil PC disponible/)

  const pinned = androidChat({ inference: 'pc', catalogue: androidCatalogue(phone, pc), remote: fail, canFallback: () => false,
    discover: async () => pc, local: failing('must not run') })
  await assert.rejects(agentTurn('Bonjour', { tools: catalogue.tools, system: catalogue.system, chat: pinned.chat }), /down/)
})
