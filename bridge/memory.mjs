import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { parseFacts } from '../shared/memory.mjs'
import { sdkDeviceTools } from './device-server.mjs'
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

/** The catalogue entries this server carries for Claude. */
export const MEMORY_TOOLS = new Set(['remember', 'forget'])

export const MEMORY_FILE = resolve(
  process.env.JARVIS_MEMORY_FILE ?? join(homedir(), '.jarvis', 'memory.md'),
)

export function readFacts() {
  return existsSync(MEMORY_FILE) ? parseFacts(readFileSync(MEMORY_FILE, 'utf8')) : []
}

/** The PC's memory primitive: the whole file. Its rules are shared/memory.mjs. */
export const memoryFile = {
  read: () => (existsSync(MEMORY_FILE) ? readFileSync(MEMORY_FILE, 'utf8') : ''),
  write(text) {
    mkdirSync(dirname(MEMORY_FILE), { recursive: true })
    writeFileSync(MEMORY_FILE, text)
  },
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

/**
 * Claude's MCP view of memory. The tools are the shared catalogue's own
 * remember and forget; the server keeps its name so that tool names
 * (mcp__jarvis_memory__*) and the policy that exempts them are unchanged.
 */
export function memoryServer(catalogue) {
  return createSdkMcpServer({
    name: 'jarvis_memory',
    version: '1.0.0',
    instructions:
      'JARVIS\'s long-term memory: short facts about the user that survive ' +
      'restarts and are shown to him at the start of every conversation.',
    tools: sdkDeviceTools(catalogue.filter((entry) => MEMORY_TOOLS.has(entry.name))),
  })
}
