import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createTrace, TRACE_FILE_BYTES, TRACE_FILES } from '../shared/trace.mjs'

/**
 * Private rotating JSONL files. Logging failure must not stop an agent action.
 *
 * Writes are asynchronous: a trace line can be several hundred kilobytes (a
 * model request with its history), and a synchronous append held the bridge's
 * event loop — every socket and every HTTP route — for as long as the disk
 * took. Order is kept by `createTrace`, which writes one line after the other.
 * The current file's size is counted, so the directory is read only to rotate.
 */
export function fileTrace(dir, { maxBytes = TRACE_FILE_BYTES, maxFiles = TRACE_FILES, context = {} } = {}) {
  let file, bytes = 0, index = 0, ready
  const stem = `jarvis-trace-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`

  /** A new file, and the oldest beyond the budget removed. */
  async function rotate() {
    file = join(dir, `${stem}-${String(index++).padStart(4, '0')}.jsonl`)
    bytes = 0
    const names = (await readdir(dir)).filter((name) => /^jarvis-trace-.*\.jsonl$/.test(name))
    const previous = (await Promise.all(names.map(async (name) => ({ name, time: (await stat(join(dir, name))).mtimeMs }))))
      .sort((a, b) => b.time - a.time)
    await Promise.all(previous.slice(Math.max(0, maxFiles - 1)).map((old) => unlink(join(dir, old.name))))
  }

  return createTrace({ context: { device: 'pc', ...context },
    onError: (err) => console.error('[jarvis] trace write failed:', err.message),
    async write(line) {
      const size = Buffer.byteLength(line)
      const append = async () => {
        ready ??= mkdir(dir, { recursive: true, mode: 0o700 })
        await ready
        if (!file || bytes + size > maxBytes) await rotate()
        await appendFile(file, line, { mode: 0o600 })
        bytes += size
      }
      try {
        await append()
      } catch (err) {
        ready = undefined
        if (err?.code !== 'ENOENT') throw err
        // The folder was removed while the bridge ran: make it again, in a new file.
        file = undefined
        await append()
      }
    },
  })
}
