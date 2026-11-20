import { createTrace, TRACE_FILE_BYTES, TRACE_FILES } from '../../shared/trace.mjs'
import { isAndroid, JarvisFiles } from './android'
import { reportTrace } from './bridge'
import { BACKEND } from '../config'
import { browserTraceStore } from './browserTrace'

// Direct API mode has no bridge. Keep the same JSONL records in browser storage.
let browserTrace: ((line: string) => Promise<void>) | undefined

export const diagnostics = createTrace({
  context: { device: isAndroid ? 'android' : 'browser' },
  onError: (error) => console.warn('[jarvis] trace write failed', error),
  async write(line) {
    if (isAndroid) await JarvisFiles.appendTrace({ line, maxBytes: TRACE_FILE_BYTES, maxFiles: TRACE_FILES })
    else if (BACKEND === 'direct') await (browserTrace ??= browserTraceStore(indexedDB, TRACE_FILE_BYTES * TRACE_FILES))(line)
    else {
      const { event, data, conversationId, turnId } = JSON.parse(line)
      await reportTrace(event, { ...data, ...(conversationId ? { conversationId, turnId } : {}) })
    }
  },
})
