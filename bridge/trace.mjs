import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createTrace, TRACE_FILE_BYTES, TRACE_FILES } from '../shared/trace.mjs'

/** Private rotating JSONL files. Logging failure must not stop an agent action. */
export function fileTrace(dir, { maxBytes = TRACE_FILE_BYTES, maxFiles = TRACE_FILES, context = {} } = {}) {
  let file, bytes = 0, index = 0
  const stem = `jarvis-trace-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  return createTrace({ context: { device: 'pc', ...context },
    onError: (err) => console.error('[jarvis] trace write failed:', err.message),
    write(line) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const size = Buffer.byteLength(line)
      if (!file || bytes + size > maxBytes) {
        file = join(dir, `${stem}-${String(index++).padStart(4, '0')}.jsonl`)
        bytes = 0
        const previous = readdirSync(dir).filter((name) => /^jarvis-trace-.*\.jsonl$/.test(name))
          .map((name) => ({ name, time: statSync(join(dir, name)).mtimeMs })).sort((a, b) => b.time - a.time)
        for (const old of previous.slice(Math.max(0, maxFiles - 1))) unlinkSync(join(dir, old.name))
      }
      appendFileSync(file, line, { mode: 0o600 })
      bytes += size
    },
  })
}
