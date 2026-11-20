/**
 * Trace lines kept in the browser's IndexedDB, for the direct API mode, which
 * has no bridge to write files: the same JSONL records within the same byte
 * budget as the files on the PC, oldest dropped first.
 *
 * The stored size is counted once per page and then kept as a running total,
 * so adding a line costs one write — and a purge only when the budget is
 * passed. It used to walk every stored record on every line.
 */
type Row = { line: string; bytes: number }

export function browserTraceStore(factory: IDBFactory, budget: number, name = 'jarvis-diagnostics') {
  let database: Promise<IDBDatabase> | undefined
  /** Bytes stored, once counted; unknown again after a failed transaction. */
  let total: number | undefined

  const open = () =>
    (database ??= new Promise((resolve, reject) => {
      const request = factory.open(name, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('records', { autoIncrement: true })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        database = undefined
        reject(request.error)
      }
    }))

  return async function write(line: string): Promise<void> {
    const db = await open()
    const bytes = new TextEncoder().encode(line).length
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite')
      const store = tx.objectStore('records')
      let stored = total

      /** Oldest first, until the total fits again. */
      const purge = () => {
        const cursor = store.openCursor(null, 'next')
        cursor.onsuccess = () => {
          const row = cursor.result
          if (!row || stored! <= budget) return
          stored! -= (row.value as Row).bytes
          row.delete()
          row.continue()
        }
      }
      const add = () => {
        store.add({ line, bytes } satisfies Row)
        stored! += bytes
        if (stored! > budget) purge()
      }

      if (stored === undefined) {
        // Once per page: what earlier pages left.
        stored = 0
        const cursor = store.openCursor()
        cursor.onsuccess = () => {
          const row = cursor.result
          if (!row) return add()
          stored! += (row.value as Row).bytes
          row.continue()
        }
      } else add()

      tx.oncomplete = () => {
        total = stored
        resolve()
      }
      tx.onerror = tx.onabort = () => {
        total = undefined
        reject(tx.error)
      }
    })
  }
}
