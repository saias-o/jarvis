import { createTrace, TRACE_FILE_BYTES, TRACE_FILES } from '../../shared/trace.mjs'
import { isAndroid, JarvisFiles } from './android'
import { reportTrace } from './bridge'
import { BACKEND } from '../config'

// Direct API mode has no bridge. Keep the same JSONL records in browser storage.
let database: Promise<IDBDatabase> | undefined
async function browserTrace(line: string) {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('jarvis-diagnostics', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('records', { autoIncrement: true })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { database = undefined; reject(request.error) }
  })
  const db = await database
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite')
    const store = tx.objectStore('records')
    store.add({ line, bytes: new TextEncoder().encode(line).length })
    // Walk newest first and discard only records outside the shared byte budget.
    let bytes = 0
    const cursor = store.openCursor(null, 'prev')
    cursor.onsuccess = () => {
      const row = cursor.result
      if (!row) return
      bytes += row.value.bytes
      if (bytes > TRACE_FILE_BYTES * TRACE_FILES) row.delete()
      row.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export const diagnostics = createTrace({
  context: { device: isAndroid ? 'android' : 'browser' },
  onError: (error) => console.warn('[jarvis] trace write failed', error),
  async write(line) {
    if (isAndroid) await JarvisFiles.appendTrace({ line, maxBytes: TRACE_FILE_BYTES, maxFiles: TRACE_FILES })
    else if (BACKEND === 'direct') await browserTrace(line)
    else {
      const { event, data, conversationId, turnId } = JSON.parse(line)
      await reportTrace(event, { ...data, ...(conversationId ? { conversationId, turnId } : {}) })
    }
  },
})
