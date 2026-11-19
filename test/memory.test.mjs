// Long-term memory: one set of rules, the same effect on the phone and the PC.
//
//   node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { androidTools } from '../shared/android-agent.mjs'
import { forgetIn, MAX_FACTS, memoryStore, parseFacts, rememberIn } from '../shared/memory.mjs'

const dir = mkdtempSync(join(tmpdir(), 'jarvis-memory-'))
const pcFile = join(dir, 'memory.md')
process.env.JARVIS_MEMORY_FILE = pcFile
// Imported after the variable is set, so the PC writes here and not to ~/.jarvis.
const { localTools } = await import('../bridge/local-tools.mjs')
const { memoryPrompt } = await import('../bridge/memory.mjs')
test.after(() => rmSync(dir, { recursive: true, force: true }))

/** The phone's native plugin, reduced to its memory file. */
function phoneFiles(initial) {
  const file = { text: initial }
  return {
    file,
    status: async () => ({ root: '/storage/emulated/0', inbox: '/phone/inbox', granted: true }),
    readMemory: async () => ({ text: file.text }),
    writeMemory: async ({ text }) => { file.text = text },
    run: async () => { throw new Error('memory never goes through the file tools') },
  }
}

const runner = (tools) => (name, args) => tools.find((tool) => tool.name === name).run(args)

test('remember, deduplicate and forget give the same results on the phone and the PC', async () => {
  // Each device starts from its own existing format.
  const phone = phoneFiles('# Memory\n\n- Lives in Lyon\n')
  writeFileSync(pcFile, '# JARVIS memory\n\n- Lives in Lyon (2026-01-02)\n')
  const devices = {
    phone: runner((await androidTools(phone, {})).tools),
    pc: runner(localTools({ cwd: dir, roots: [dir] })),
  }
  const steps = [
    ['remember', { fact: '  Daughter   is called\nLéa ' }, 'Remembered.'],
    ['remember', { fact: 'daughter is called léa' }, 'Already remembered.'],
    ['remember', { fact: 'lives in lyon' }, 'Already remembered.'],
    ['remember', { fact: ' ' }, 'Nothing to remember.'],
    ['forget', { match: 'Paris' }, 'Nothing matched.'],
    ['forget', { match: 'LYON' }, 'Forgot 1 fact(s).'],
    ['forget', { match: '' }, 'Nothing matched.'],
  ]
  for (const [name, args, expected] of steps) {
    for (const [device, run] of Object.entries(devices)) {
      assert.equal(await run(name, args), expected, `${device} ${name} ${JSON.stringify(args)}`)
    }
  }
  const facts = (text) => parseFacts(text).map((line) => line.replace(/ \(\d{4}-\d{2}-\d{2}\)$/, ''))
  assert.deepEqual(facts(phone.file.text), ['- Daughter is called Léa'])
  assert.deepEqual(facts(readFileSync(pcFile, 'utf8')), facts(phone.file.text))
  assert.match(phone.file.text, /^# JARVIS memory\n\n- Daughter is called Léa \(\d{4}-\d{2}-\d{2}\)\n$/)
  assert.match(memoryPrompt(), /- Daughter is called Léa/)
})

test('the file keeps the newest facts, and concurrent calls never lose one', async () => {
  let text = ''
  for (let i = 0; i < MAX_FACTS + 5; i++) text = rememberIn(text, `fact ${i}.`, '2026-11-19').text
  const kept = parseFacts(text)
  assert.equal(kept.length, MAX_FACTS)
  assert.equal(kept[0], '- fact 5. (2026-11-19)')
  assert.equal(rememberIn(text, 'x'.repeat(400)).text.split('\n').at(-2).length, 2 + 300 + 13)
  assert.equal(forgetIn(text, 'nothing like this').text, text)

  // A slow file: two calls in flight must both end up in it.
  const file = { text: '', read: async () => { await new Promise((r) => setTimeout(r, 5)); return file.text }, write: async (t) => { file.text = t } }
  const results = await Promise.all([memoryStore(file).remember('first'), memoryStore(file).remember('second')])
  assert.deepEqual(results, ['Remembered.', 'Remembered.'])
  assert.equal(parseFacts(file.text).length, 2)
})

test('a device without a memory file is not offered remember or forget', async () => {
  const { deviceTools } = await import('../shared/tools.mjs')
  const names = deviceTools({ list: async () => [], read: async () => ({ text: '', total: 0 }) }).map((tool) => tool.name)
  assert.deepEqual(names, ['list_files', 'read_file'])
})
