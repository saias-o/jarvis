// The device agent's tool catalogue: one definition for the phone and the PC,
// and the web tools they share.
//
//   node --test test/
//
// No network: a scripted transport stands in for Capacitor's client and net.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { androidTools } from '../shared/android-agent.mjs'
import { LOCAL_CONTEXT_BYTES, fitContext } from '../shared/context-window.mjs'
import { deviceTools } from '../shared/tools.mjs'
import { htmlToText, webImage, webTools } from '../shared/web-tools.mjs'
import { localTools } from '../bridge/local-tools.mjs'

const phoneFiles = (run = async () => ({ result: '[]' })) => ({
  status: async () => ({ root: '/storage/emulated/0', inbox: '/data/user/0/dev.jarvis.app/files/inbox', granted: true }),
  readMemory: async () => ({ text: '' }),
  run,
})

/** A transport that answers from a table and records what it was asked. */
function scripted(routes) {
  const asked = []
  const http = async (request) => {
    asked.push(request)
    const route = Object.entries(routes).find(([prefix]) => request.url.startsWith(prefix))
    if (!route) throw new Error(`unexpected request to ${request.url}`)
    return typeof route[1] === 'function' ? route[1](request) : route[1]
  }
  return { http, asked }
}

const DDG = `<div class="result results_links"><h2 class="result__title">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/y.js?ad_domain=ads.example">Sponsored</a></h2></div>
<div class="result results_links"><h2 class="result__title">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmeteo.example%2Fparis%3Fa%3D1&amp;rut=abc">M&eacute;t&#233;o <b>Paris</b></a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Demain &agrave; <b>Paris</b> : 13&#xB0;C, averses.</a></div>
<div class="result results_links"><a class="result__a" href="https://second.example/page">Second</a></div>`

test('the phone and the PC offer the same tools, from the same definitions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-catalogue-'))
  try {
    const phone = await androidTools(phoneFiles(), { show: () => {}, ui: () => {}, http: async () => ({}) })
    const pc = localTools({ allowWrites: true, cwd: dir, roots: [dir], show: () => {}, ui: () => {} })
    const spec = (tools) => tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
    assert.deepEqual(spec(phone.tools), spec(pc))
    assert.deepEqual(phone.tools.map((tool) => tool.name),
      ['list_files', 'read_file', 'write_file', 'move_file', 'open', 'remember', 'forget', 'show', 'display', 'blade', 'probe_url',
        'ui_theme', 'ui_reactor', 'ui_orbit', 'ui_chrome', 'ui_effect', 'ui_screen', 'ui_reset', 'web_search', 'web_fetch'])
    // The shell is the one capability only a computer has, and only on request.
    const shell = localTools({ allowWrites: true, cwd: dir, roots: [dir], show: () => {}, ui: () => {}, shell: true })
    assert.deepEqual(shell.map((tool) => tool.name).filter((name) => !phone.tools.some((tool) => tool.name === name)), ['run_command'])
    assert.match(phone.system, /web_search/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a capability the device does not hand over is not offered', () => {
  const names = deviceTools({ list: async () => [], read: async () => ({ text: '', total: 0 }), memory: { read: () => '', write: () => {} } })
    .map((tool) => tool.name)
  assert.deepEqual(names, ['list_files', 'read_file', 'remember', 'forget'])
})

test('folders are filtered, sorted and paged by the catalogue, whatever the device', async () => {
  const entries = [
    { name: 'zeta.txt', dir: false, size: 3 }, { name: 'Photos', dir: true, size: 0 },
    { name: 'alpha.PDF', dir: false, size: 10 }, { name: 'clip.mp4', dir: false, size: 99 },
    ...Array.from({ length: 60 }, (_, i) => ({ name: `note-${String(i).padStart(2, '0')}.md`, dir: false, size: i })),
  ]
  const asked = []
  const tools = deviceTools({
    list: async (folder) => { asked.push(folder); return entries },
    read: async (path, from, length) => ({ text: 'é'.repeat(5000).slice(from, from + length), total: 5000 }),
    memory: { read: () => '', write: () => {} },
  }, { page: 600 })
  const run = (name, args) => tools.find((tool) => tool.name === name).run(args)

  const first = await run('list_files', { folder: '/sdcard' })
  assert.match(first, /^alpha\.PDF \(10 bytes\)\nclip\.mp4 \(99 bytes\)\nnote-00\.md/)
  assert.ok(first.length <= 600)
  const next = Number(/(\d+) more entries; continue with from=(\d+)\]$/.exec(first)[2])
  assert.match(await run('list_files', { folder: '/sdcard', from: next }), new RegExp(`^note-${String(next - 2).padStart(2, '0')}\\.md`))
  assert.equal(await run('list_files', { folder: '/sdcard', kind: 'documents', contains: 'A' }),
    'alpha.PDF (10 bytes)\nzeta.txt (3 bytes)\n[End of folder: 2 entries total]')
  assert.equal(await run('list_files', { folder: '/sdcard', contains: 'photo' }), 'Photos/\n[End of folder: 1 entries total]')
  await assert.rejects(run('list_files', { folder: '/sdcard', kind: 'videos' }), /kind/)
  assert.deepEqual([...new Set(asked)], ['/sdcard'])

  const page = await run('read_file', { path: '/sdcard/a.txt' })
  assert.match(page, /^é{600}\n\[4400 more characters; read on with from=600\]$/)
  assert.equal(await run('read_file', { path: '/sdcard/a.txt', from: 4900 }), 'é'.repeat(100))
})

test('on-device Gemma is given pages that still fit its context after a web search', async () => {
  const { http } = scripted({ 'https://html.duckduckgo.com/': { status: 200, headers: {}, data: DDG.repeat(8) } })
  const { tools, system } = await androidTools(phoneFiles(), { show: () => {}, http, context: LOCAL_CONTEXT_BYTES })
  const specs = tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }))
  const found = await tools.find((tool) => tool.name === 'web_search').run({ query: 'météo Paris demain' })
  assert.match(found, /^1\. Météo Paris\nhttps:\/\/meteo\.example\/paris\?a=1\nDemain à Paris : 13°C, averses\./)
  assert.doesNotThrow(() => fitContext([
    { role: 'system', content: system },
    { role: 'user', content: 'Fais une recherche internet sur la météo de demain à Paris et dis-moi s’il faut un parapluie.' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'météo Paris demain' } } }] },
    { role: 'tool', tool_name: 'web_search', content: found },
  ], specs))
})

test('web_search reads DuckDuckGo, skips sponsored links and falls back to Exa', async () => {
  const ddg = scripted({ 'https://html.duckduckgo.com/': { status: 200, headers: {}, data: DDG } })
  const [search] = webTools(ddg.http)
  assert.equal(await search.run({ query: 'météo Paris' }),
    '1. Météo Paris\nhttps://meteo.example/paris?a=1\nDemain à Paris : 13°C, averses.\n2. Second\nhttps://second.example/page')
  assert.equal(ddg.asked[0].url, 'https://html.duckduckgo.com/html/?q=m%C3%A9t%C3%A9o%20Paris')

  const exa = scripted({
    'https://html.duckduckgo.com/': { status: 202, headers: {}, data: '<html>anomaly</html>' },
    'https://mcp.exa.ai/mcp': (request) => {
      assert.equal(request.method, 'POST')
      assert.equal(request.data.params.arguments.query, 'météo Paris')
      return { status: 200, headers: { 'Content-Type': 'text/event-stream' },
        data: `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: 'text', text: 'Title: Météo\nURL: https://meteo.example' }] } })}\n\n` }
    },
  })
  assert.equal(await webTools(exa.http)[0].run({ query: 'météo Paris' }), 'Title: Météo\nURL: https://meteo.example')

  const down = scripted({ 'https://': () => { throw new Error('Unable to resolve host') } })
  await assert.rejects(webTools(down.http)[0].run({ query: 'x' }), /returned nothing \(DuckDuckGo: Unable to resolve host ; Exa: Unable to resolve host\)/)
  await assert.rejects(webTools(down.http)[0].run({ query: ' ' }), /words to search/)
})

test('web_fetch returns the words of a page, in pages, and refuses what is not text', async () => {
  const body = `<!doctype html><html><head><title>Bulletin &amp; pr&eacute;visions</title><style>p{color:red}</style></head>
<body><script>alert("no")</script><h1>Paris</h1><p>Averses l&#233;g&egrave;res.</p><p>${'mot '.repeat(400)}</p></body></html>`
  const { http, asked } = scripted({
    'https://meteo.example/old': { status: 301, headers: { Location: '/paris' }, data: '' },
    'https://meteo.example/paris': { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data: body },
    'https://meteo.example/data': { status: 200, headers: { 'Content-Type': 'application/json' }, data: { temp: 13 } },
    'https://meteo.example/file.pdf': { status: 200, headers: { 'Content-Type': 'application/pdf' }, data: '%PDF' },
    'https://meteo.example/gone': { status: 404, headers: {}, data: 'no' },
  })
  const fetch = webTools(http, { limit: 700 })[1]
  const first = await fetch.run({ url: 'https://meteo.example/old' })
  assert.match(first, /^Bulletin & prévisions\nhttps:\/\/meteo\.example\/paris\nParis\nAverses légères\.\nmot mot/)
  assert.doesNotMatch(first, /alert|color/)
  assert.ok(first.length <= 700)
  assert.deepEqual(asked.map((request) => request.url), ['https://meteo.example/old', 'https://meteo.example/paris'])
  const from = Number(/continue with from=(\d+)\]$/.exec(first)[1])
  assert.match(await fetch.run({ url: 'https://meteo.example/paris', from }), /^[mot ]+\n\[\d+ more characters; continue with from=\d+\]$/)

  assert.equal(await fetch.run({ url: 'https://meteo.example/data' }), 'https://meteo.example/data\n{"temp":13}')
  assert.match(await fetch.run({ url: 'https://meteo.example/file.pdf' }), /application\/pdf file/)
  await assert.rejects(fetch.run({ url: 'https://meteo.example/gone' }), /answered 404/)
})

test('a picture from the web can be found and shown, even by a screen that cannot load the web', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
  const { http, asked } = scripted({
    'https://fr.wikipedia.example/wiki/Tour_Eiffel': { status: 200, headers: { 'content-type': 'text/html' },
      data: `<html><head><title>Tour Eiffel</title><meta name="twitter:image" content="http://192.168.1.1/private.png">
<meta content="//upload.example/eiffel.jpg?w=1200&amp;h=800" property="og:image"></head><body><main>${'La tour. '.repeat(40)}</main></body></html>` },
    'https://upload.example/eiffel.jpg': { status: 302, headers: { Location: 'https://cdn.example/eiffel.png' }, data: '' },
    'https://cdn.example/eiffel.png': (request) => {
      assert.equal(request.binary, true)
      // Android's encoder wraps its base64 in lines.
      return { status: 200, headers: { 'Content-Type': 'image/png' }, data: `${png.slice(0, 6)}\n${png.slice(6)}\n` }
    },
    'https://cdn.example/huge.png': { status: 200, headers: { 'content-type': 'image/png' }, data: 'A'.repeat(4000) },
  })
  // What the model reads names the picture's address…
  const page = await webTools(http)[1].run({ url: 'https://fr.wikipedia.example/wiki/Tour_Eiffel' })
  assert.match(page, /^Tour Eiffel\nhttps:\/\/fr\.wikipedia\.example\/wiki\/Tour_Eiffel\nImage: https:\/\/upload\.example\/eiffel\.jpg\?w=1200&h=800\nLa tour\./)
  assert.equal(asked.at(-1).binary, undefined)
  // …and the phone turns that address into data its own page may display.
  assert.equal(await webImage(http, 'https://upload.example/eiffel.jpg?w=1200&h=800'), `data:image/png;base64,${png}`)
  await assert.rejects(webImage(http, 'https://fr.wikipedia.example/wiki/Tour_Eiffel'), /not an image file; use the Image: address/)
  await assert.rejects(webImage(http, 'https://cdn.example/huge.png', { maxBytes: 1000 }), /too large/)
  await assert.rejects(webImage(http, 'http://192.168.1.1/private.png'), /blocked host/)

  // The shared show tool hands the address to the device's screen as it is.
  let shown
  const { tools, system } = await androidTools(phoneFiles(), { show: (blade) => { shown = blade }, http })
  await tools.find((tool) => tool.name === 'show').run({ title: 'Tour Eiffel', image: 'https://upload.example/eiffel.jpg' })
  assert.equal(shown.kind, 'image')
  assert.equal(shown.url, 'https://upload.example/eiffel.jpg')
  assert.match(system, /Pour montrer une image du web : web_search, web_fetch/)
})

test('the web tools never reach a private address, directly or by redirect', async () => {
  const { http, asked } = scripted({
    'https://public.example/': { status: 302, headers: { location: 'http://192.168.1.1/admin' }, data: '' },
  })
  const fetch = webTools(http)[1]
  for (const url of ['http://127.0.0.1:8787/health', 'http://192.168.1.1/', 'https://pc.tail1234.ts.net/file?path=C:/x',
    'http://router/', 'http://[::1]/', 'http://nas.local/', 'file:///etc/passwd', 'not a url']) {
    await assert.rejects(fetch.run({ url }), /blocked host|url required/, url)
  }
  await assert.rejects(fetch.run({ url: 'https://public.example/' }), /blocked host/)
  assert.deepEqual(asked.map((request) => request.url), ['https://public.example/'])
})

test('a cancelled turn stops waiting for a transport that cannot be cancelled', async () => {
  const controller = new AbortController()
  const pending = webTools(() => new Promise(() => {}))[1].run({ url: 'https://slow.example/' }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('markup becomes plain words', () => {
  assert.equal(htmlToText('<div>Un&nbsp;&laquo;&nbsp;test&nbsp;&raquo;<br>ligne <b>deux</b></div><!-- x --><p>&#128512; &unknown;</p>'),
    'Un « test »\nligne deux\n😀 &unknown;')
})

test('probe_url says what is at an address the way the reading view will see it, on any device', async () => {
  const prose = `<html><head><title>Le rapport</title><meta property="og:image" content="https://cdn.example/lead.jpg"></head>
<body><nav>${'<a href="/x">lien</a> '.repeat(50)}</nav><article>${'<p>Une phrase complète avec assez de mots pour compter comme de la prose réelle.</p>'.repeat(20)}</article></body></html>`
  const links = `<html><head><title>Liens</title></head><body>${'<li><a href="/a">Un lien parmi tant d’autres sur cette page</a></li>'.repeat(200)}</body></html>`
  const { http, asked } = scripted({
    'https://cdn.example/photo': (request) => ({ status: 200, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '2048' }, data: request.method === 'HEAD' ? '' : 'binary' }),
    'https://news.example/article': (request) => request.method === 'HEAD'
      ? { status: 405, headers: {}, data: '' } : { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data: prose },
    'https://news.example/links': { status: 200, headers: { 'content-type': 'text/html' }, data: links },
  })
  const tools = deviceTools({ list: async () => [], read: async () => ({ text: '', total: 0 }), show: () => {}, http })
  const probe = async (url) => JSON.parse(await tools.find((tool) => tool.name === 'probe_url').run({ url }))

  assert.deepEqual(await probe('https://cdn.example/photo'), { ok: true, url: 'https://cdn.example/photo', status: 200,
    contentType: 'image/jpeg', bytes: 2048, kind: 'image', suggestion: 'blade_image' })
  // A picture is never downloaded to learn its type.
  assert.deepEqual(asked.filter((r) => r.url === 'https://cdn.example/photo').map((r) => r.method), ['HEAD'])
  const article = await probe('https://news.example/article')
  assert.equal(article.suggestion, 'blade_reader')
  assert.equal(article.title, 'Le rapport')
  assert.equal(article.leadImage, 'https://cdn.example/lead.jpg')
  assert.ok(article.readableChars > 900)
  // Link text is not prose: the reading view would open on nothing.
  assert.equal((await probe('https://news.example/links')).suggestion, 'blade_live')
  assert.match((await probe('http://192.168.1.1/')).reason, /blocked host/)
})
