/**
 * JARVIS's long-term memory rules, the same on every device.
 *
 * One Markdown file of short facts, one bullet each. A device supplies only
 * reading and writing its own file; the format, the limits, deduplication and
 * what `forget` matches live here. Both existing files are read: the PC's
 * `# JARVIS memory` with dated facts and the phone's older `# Memory` with
 * plain ones. Any line starting with "- " is a fact.
 *
 * Browser-safe: the phone runs this inside its WebView.
 */

/** Every fact is in every prompt, so the file is capped rather than trusted. */
export const MAX_FACTS = 200
export const MAX_FACT_CHARS = 300
const HEADER = '# JARVIS memory\n\n'

export const parseFacts = (text) => String(text ?? '').split(/\r?\n/).filter((line) => line.startsWith('- '))
export const formatFacts = (facts) => HEADER + facts.join('\n') + (facts.length ? '\n' : '')

const today = () => new Date().toISOString().slice(0, 10)

/** Add one fact unless an existing one already says it. Returns the new text and what the model is told. */
export function rememberIn(text, fact, date = today()) {
  const clean = String(fact ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS)
  if (!clean) return { text, result: 'Nothing to remember.' }
  const facts = parseFacts(text)
  if (facts.some((line) => line.toLowerCase().includes(clean.toLowerCase()))) return { text, result: 'Already remembered.' }
  // Oldest facts go first when the file is full.
  return { text: formatFacts([...facts, `- ${clean} (${date})`].slice(-MAX_FACTS)), result: 'Remembered.' }
}

/** Remove the facts containing these words, case-insensitively, and say how many went. */
export function forgetIn(text, match) {
  const needle = String(match ?? '').trim().toLowerCase()
  if (!needle) return { text, result: 'Nothing matched.' }
  const facts = parseFacts(text)
  const kept = facts.filter((line) => !line.toLowerCase().includes(needle))
  const removed = facts.length - kept.length
  return removed ? { text: formatFacts(kept), result: `Forgot ${removed} fact(s).` } : { text, result: 'Nothing matched.' }
}

const queues = new WeakMap()

/**
 * remember and forget over a device's file primitives. Changes are applied one
 * at a time, so two calls in flight cannot both rewrite the file from the same
 * reading.
 *
 * @param {{ read(): Promise<string> | string, write(text: string): Promise<unknown> | unknown }} file
 */
export function memoryStore(file) {
  // One queue per file, shared by every catalogue built on it.
  const change = (edit) => {
    const next = (queues.get(file) ?? Promise.resolve()).then(async () => {
      const before = (await file.read()) ?? ''
      const { text, result } = edit(before)
      if (text !== before) await file.write(text)
      return result
    })
    queues.set(file, next.catch(() => {}))
    return next
  }
  return {
    remember: (fact) => change((text) => rememberIn(text, fact)),
    forget: (match) => change((text) => forgetIn(text, match)),
  }
}
