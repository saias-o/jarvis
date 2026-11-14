import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInference } from '../bridge/inference.mjs'
import { remoteChat } from '../shared/remote-chat.mjs'
import { androidTools } from '../shared/android-agent.mjs'
import { agentTurn } from '../shared/agent-loop.mjs'

test('PC inference lists Android Download using the phone tools and retains phone attachments', async () => {
  const executed = []
  let shown
  const { tools, system } = await androidTools({
    status: async () => ({ root: '/storage/emulated/0', inbox: '/data/user/0/dev.jarvis.app/files/inbox', granted: true }),
    readMemory: async () => ({ text: '' }),
    run: async (call) => { executed.push(call); return { result: 'facture-telephone.pdf\n[End; 1 total]' } },
  }, (title, text) => { shown = { title, text } })
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
  assert.equal(shown.text, 'facture-telephone.pdf')
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
