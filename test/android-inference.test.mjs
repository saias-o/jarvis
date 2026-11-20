import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInference } from '../bridge/inference.mjs'
import { remoteChat } from '../shared/remote-chat.mjs'
import { androidTools } from '../shared/android-agent.mjs'
import { agentTurn } from '../shared/agent-loop.mjs'

test('the remote inference budget includes tools, history, diagnostics and UTF-8 bytes', async () => {
  const current = [{ role: 'user', content: 'follow up' }, { role: 'assistant', content: '', tool_calls: [] },
    { role: 'tool', content: 'verified result', tool_name: 'read_file' }]
  const system = { role: 'system', content: 'instructions' }
  let sent
  const fetcher = async (_url, { body }) => {
    assert.ok(Buffer.byteLength(body) <= 256 * 1024)
    sent = JSON.parse(body)
    return Response.json({ message: { content: 'done', tool_calls: [] } })
  }
  await remoteChat(fetcher, 'https://pc.test', [system, { role: 'user', content: 'old' },
    { role: 'assistant', content: 'é'.repeat(130_000) }, ...current], [{ description: 't'.repeat(4000) }], undefined, { turnId: 'a' }).next()
  assert.deepEqual(sent.messages, [system, ...current])
  await assert.rejects(remoteChat(fetcher, 'https://pc.test', [system, { role: 'user', content: 'é'.repeat(135_000) }], []).next(), /capacité/)
})

test('PC inference lists Android Download using the phone tools and retains phone attachments', async () => {
  const executed = []
  let shown
  const { tools, system } = await androidTools({
    status: async () => ({ root: '/storage/emulated/0', inbox: '/data/user/0/dev.jarvis.app/files/inbox', granted: true }),
    readMemory: async () => ({ text: '' }),
    run: async (call) => { executed.push(call); return { result: JSON.stringify([{ name: 'facture-telephone.pdf', dir: false, size: 1200 }]) } },
  }, { show: (blade) => { shown = blade } })
  let step = 0
  const infer = createInference({ model: 'fake-pc', query: ({ prompt, options }) => {
    const input = JSON.parse(prompt)
    assert.deepEqual(options.tools, [])
    assert.deepEqual(options.mcpServers, {})
    assert.equal(options.strictMcpConfig, true)
    assert.equal(options.settings.disableClaudeAiConnectors, true)
    assert.equal(options.persistSession, false)
    const request = step++
    return (async function* () {
      assert.equal((await options.canUseTool('Bash')).behavior, 'deny')
      assert.equal((await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Read' })).hookSpecificOutput.permissionDecision, 'deny')
      let answer
      if (request === 0) {
        assert.match(input.messages[0].content, /téléphone Android/)
        assert.match(input.messages.at(-1).content, /\/data\/user\/0/)
        answer = { content: 'Les fichiers sont déjà affichés.', calls: [{ name: 'list_files', arguments: { folder: '/storage/emulated/0/Download' } }] }
      } else if (request === 1) {
        assert.equal(input.messages.at(-1).role, 'tool')
        assert.match(input.messages.at(-1).content, /facture-telephone.pdf/)
        answer = { content: '', calls: [{ name: 'show', arguments: { title: 'Download du téléphone', text: 'facture-telephone.pdf' } }] }
      } else answer = { content: 'Un document sur votre téléphone, affiché à l’écran.', calls: [] }
      yield { type: 'result', subtype: 'success', structured_output: answer }
    })()
  } })
  const fetcher = async (url, init) => {
    assert.equal(url, 'https://pc.example.ts.net/inference')
    return Response.json(await infer(JSON.parse(init.body), init.signal))
  }
  const text = await agentTurn('Liste Download. Pièce jointe : /data/user/0/dev.jarvis.app/files/inbox/note.txt', {
    system, tools, chat: (messages, specs, signal) => remoteChat(fetcher, 'https://pc.example.ts.net', messages, specs, signal),
  })
  assert.deepEqual(executed, [{ name: 'list_files', args: { folder: '/storage/emulated/0/Download' } }])
  assert.equal(shown.html, '<p>facture-telephone.pdf</p>')
  assert.equal(text, 'Un document sur votre téléphone, affiché à l’écran.')
  assert.equal(step, 3)
})

test('inference rejects unoffered PC tools before the phone can execute them', async () => {
  const infer = createInference({ query: () => (async function* () {
    yield { type: 'result', subtype: 'success', structured_output: { content: '', calls: [{ name: 'Bash', arguments: { command: 'dir' } }] } }
  })() })
  await assert.rejects(infer({ messages: [{ role: 'user', content: 'list' }], tools: [] }), /Invalid PC inference response/)
  await assert.rejects(async () => {
    for await (const chunk of remoteChat(async () => Response.json({ message: { content: '', tool_calls: [{ function: { name: 'Read', arguments: {} } }] } }), 'https://pc', [], [])) void chunk
  }, /invalide/)
})

test('cancelled remote inference cannot execute a returned Android write', async () => {
  const controller = new AbortController()
  let writes = 0
  const tool = { name: 'write_file', parameters: {}, run: () => { writes++ } }
  await assert.rejects(agentTurn('write', {
    tools: [tool], signal: controller.signal,
    chat: (messages, specs, signal) => remoteChat(async () => {
      controller.abort()
      return Response.json({ message: { content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: '/sdcard/test' } } }] } })
    }, 'https://pc', messages, specs, signal),
  }), { name: 'AbortError' })
  assert.equal(writes, 0)
})

test('inference cancellation closes the SDK query and propagates to its process', async () => {
  const controller = new AbortController()
  let options
  let closed = false
  const infer = createInference({ query: (args) => {
    options = args.options
    const iterator = (async function* () {
      controller.abort()
      yield { type: 'result', subtype: 'success', structured_output: { content: 'late', calls: [] } }
    })()
    iterator.close = () => { closed = true }
    return iterator
  } })
  await assert.rejects(infer({ messages: [{ role: 'user', content: 'hello' }], tools: [] }, controller.signal), { name: 'AbortError' })
  assert.equal(options.abortController.signal.aborted, true)
  assert.equal(closed, true)
})

test('native client tool_use is forwarded to Android before the SDK can call it nonexistent', async () => {
  let closed = false
  const infer = createInference({ query: () => {
    const session = (async function* () {
      yield { type: 'assistant', message: { content: [
        { type: 'text', text: 'Already moved.' },
        { type: 'tool_use', name: 'pc_list_files', input: { folder: 'C:/Users/sandr/OneDrive' } },
      ] } }
      assert.fail('The SDK must not continue and turn a client proposal into a No such tool error')
    })()
    session.close = () => { closed = true }
    return session
  } })
  const result = await infer({ messages: [{ role: 'user', content: 'Trouve Images sur le PC.' }], tools: [{
    type: 'function', function: { name: 'pc_list_files', parameters: { type: 'object', properties: { folder: { type: 'string' } }, required: ['folder'] } },
  }] })
  assert.deepEqual(result.message, { content: '', tool_calls: [{ function: { name: 'pc_list_files', arguments: { folder: 'C:/Users/sandr/OneDrive' } } }] })
  assert.equal(closed, true)
})

test('a native SDK tool absent from the client manifest is never forwarded', async () => {
  const infer = createInference({ query: () => (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'dir' } }] } }
    yield { type: 'result', subtype: 'success', structured_output: { content: 'Pas d’outil proposé.', calls: [] } }
  })() })
  const result = await infer({ messages: [{ role: 'user', content: 'test' }], tools: [] })
  assert.deepEqual(result.message.tool_calls, [])
})

test('a camera frame reaches the PC as image content, marked in the conversation', async () => {
  const frame = Buffer.from('a camera frame').toString('base64')
  let prompt
  const infer = createInference({ model: 'fake-pc', query: (params) => {
    prompt = params.prompt
    return (async function* () {
      // The transport is streaming input, so the whole conversation is one
      // user message: the JSON first, then the bytes of each frame.
      assert.equal(typeof prompt, 'object')
      const sent = []
      for await (const message of prompt) sent.push(message)
      assert.equal(sent.length, 1)
      const blocks = sent[0].message.content
      assert.equal(sent[0].parent_tool_use_id, null)
      const json = JSON.parse(blocks[0].text)
      assert.equal(json.messages.at(-1).images, undefined)
      assert.match(json.messages.at(-1).content, /One frame from the camera:\n\[image 1\]/)
      assert.deepEqual(blocks.slice(1), [
        { type: 'text', text: '[image 1] :' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame } },
      ])
      yield { type: 'result', subtype: 'success', structured_output: { content: 'Vous tenez une tasse.', calls: [] } }
    })()
  } })
  const conversation = [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'Que tiens-je ?' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'look', arguments: {} } }] },
    { role: 'tool', tool_name: 'look', content: 'One frame from the camera:', images: [frame] }]
  const fetcher = async (_url, init) => Response.json(await infer(JSON.parse(init.body), init.signal))
  const { value } = await remoteChat(fetcher, 'https://pc.test', conversation,
    [{ type: 'function', function: { name: 'look', parameters: { type: 'object' } } }]).next()
  assert.equal(value.message.content, 'Vous tenez une tasse.')

  // A frame that is not base64 is refused before the SDK is started.
  await assert.rejects(infer({ messages: [{ role: 'user', content: 'x', images: ['not base64!'] }], tools: [] }), /Invalid inference request/)
})

test('only the newest frames are sent, and an oversized one is dropped rather than refusing the turn', async () => {
  const frame = (seed) => Buffer.from(seed.repeat(32)).toString('base64')
  const bodies = []
  const fetcher = async (_url, { body }) => {
    assert.ok(Buffer.byteLength(body) <= 256 * 1024)
    bodies.push(JSON.parse(body))
    return Response.json({ message: { content: 'ok', tool_calls: [] } })
  }
  const look = (seed) => ({ role: 'tool', tool_name: 'look', content: 'One frame from the camera:', images: [frame(seed)] })
  await remoteChat(fetcher, 'https://pc.test', [{ role: 'system', content: 's' }, { role: 'user', content: 'q' },
    look('a'), look('b'), look('c')], []).next()
  // Three looks in one turn, two frames allowed: the oldest is left behind,
  // and the newest two travel.
  assert.deepEqual(bodies[0].messages.map((message) => message.images?.length ?? 0), [0, 0, 0, 1, 1])
  assert.equal(bodies[0].messages[3].images[0], frame('b'))

  // One frame alone over the body budget: the turn still goes, saying so.
  const huge = 'A'.repeat(300 * 1024)
  await remoteChat(fetcher, 'https://pc.test',
    [{ role: 'system', content: 's' }, { role: 'user', content: 'q' },
      { role: 'tool', tool_name: 'look', content: 'One frame from the camera:', images: [huge] }], []).next()
  const sent = bodies[1].messages.at(-1)
  assert.equal(sent.images, undefined)
  assert.match(sent.content, /image non transmise/)
})
