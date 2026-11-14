import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * JARVIS's long-term memory.
 *
 * Every socket starts a new agent session, so without this he forgets the
 * user's name, their preferences and everything they told him the moment the
 * page reloads. The fix is deliberately plain: one Markdown file of short
 * facts, one bullet each. `remember` appends to it, `forget` removes lines,
 * and the whole file is put into the system prompt of every new session —
 * there is no recall tool, because a voice turn cannot afford a lookup before
 * it knows what it already knows.
 *
 * The file lives beside the workspace, not inside it, so the file tools never
 * see it as something to edit, and the user can read or fix it by hand.
 */

export const MEMORY_FILE = resolve(
  process.env.JARVIS_MEMORY_FILE ?? join(homedir(), '.jarvis', 'memory.md'),
)

/** Every line is in every prompt, so the file is capped rather than trusted. */
const MAX_FACTS = 200
const MAX_FACT_CHARS = 300

const HEADER = '# JARVIS memory\n\n'

export function readFacts() {
  if (!existsSync(MEMORY_FILE)) return []
  return readFileSync(MEMORY_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- '))
}

function writeFacts(facts) {
  mkdirSync(dirname(MEMORY_FILE), { recursive: true })
  writeFileSync(MEMORY_FILE, HEADER + facts.join('\n') + (facts.length ? '\n' : ''))
}

/** The prompt section for a new session; empty when nothing is remembered. */
export function memoryPrompt() {
  const facts = readFacts()
  const body = facts.length
    ? `What you remember from earlier conversations (oldest first):\n${facts.join('\n')}\n`
    : 'You remember nothing from earlier conversations yet.\n'
  return `
Your memory:
- You have a long-term memory that survives restarts. ${body}- Keeping it is YOUR job, not theirs. They will almost never say "remember
  this". When you hear or find something that is genuinely important — that
  will clearly make your answers better in future conversations — call
  \`remember\` on your own initiative, in the same turn, before you answer.
- The bar is high. Ask: will knowing this change how I answer them later? If
  not, or if you are unsure, do not store it. A short memory of what matters
  beats a long one of everything.
- Typically worth it: their name and how to address them; the people they
  mention often and who they are; where they live; standing preferences about
  how you should answer or act; lasting projects or commitments; a fact you
  had to dig for with your tools and will plainly need again.
- Not worth it: small talk, one-off questions and their answers, passing moods,
  details of a task that is finished, what is already in memory, and anything
  secret — passwords, codes, card or account numbers.
- Never ask whether to remember and never announce it; at most a word.
- When they ask you to forget something, or a fact is no longer true, call
  \`forget\`. A changed fact is a forget followed by a remember.
- Never say you have no persistent memory: you do.
`
}

const today = () => new Date().toISOString().slice(0, 10)

/**
 * The two operations themselves, apart from the Agent SDK wrapping below, so
 * the local brain (local-tools.mjs) keeps the same memory by the same rules.
 * Each returns the sentence the model is told.
 */
export function rememberFact(fact) {
  const clean = String(fact ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS)
  if (!clean) return 'Nothing to remember.'
  const facts = readFacts()
  if (facts.some((line) => line.toLowerCase().includes(clean.toLowerCase()))) {
    return 'Already remembered.'
  }
  facts.push(`- ${clean} (${today()})`)
  // Oldest facts go first when the file is full.
  writeFacts(facts.slice(-MAX_FACTS))
  return 'Remembered.'
}

export function forgetFacts(match) {
  const needle = String(match ?? '').trim().toLowerCase()
  if (!needle) return 'Nothing matched.'
  const facts = readFacts()
  const kept = facts.filter((line) => !line.toLowerCase().includes(needle))
  const removed = facts.length - kept.length
  if (removed) writeFacts(kept)
  return removed ? `Forgot ${removed} fact(s).` : 'Nothing matched.'
}

export function memoryServer() {
  return createSdkMcpServer({
    name: 'jarvis_memory',
    version: '1.0.0',
    instructions:
      'JARVIS\'s long-term memory: short facts about the user that survive ' +
      'restarts and are shown to him at the start of every conversation.',
    tools: [
      tool(
        'remember',
        'Keep one fact for future conversations. Call it unprompted when you ' +
          'learn something genuinely important that will make later answers ' +
          'better; they will rarely ask, and trivia does not belong here. One ' +
          'short sentence in the ' +
          'user\'s language, standing on its own ("Their daughter is called ' +
          'Léa."), not a transcript. Do not store secrets: passwords, codes, ' +
          'card or account numbers.',
        { fact: z.string().describe('The fact, one short sentence.') },
        async ({ fact }) => ({ content: [{ type: 'text', text: rememberFact(fact) }] }),
      ),
      tool(
        'forget',
        'Remove remembered facts that contain the given words (case does not ' +
          'matter). Use words specific enough to match only what should go.',
        { match: z.string().describe('Words the facts to remove contain.') },
        async ({ match }) => ({ content: [{ type: 'text', text: forgetFacts(match) }] }),
      ),
    ],
  })
}
