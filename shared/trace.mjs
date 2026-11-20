/** Structured diagnostics shared by every device; persistence is a primitive. */
export const TRACE_FILE_BYTES = 10 * 1024 * 1024
export const TRACE_FILES = 10
const secret = /(?:^|[-_])(?:authorization(?:_token)?|cookie|password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|credentials|remote[-_]?code|sig|signature)$/i

export function traceData(value, key = '', depth = 0) {
  if (secret.test(key)) return '[redacted]'
  if (/^(thinking|reasoning|signature_data)$/i.test(key)) return '[omitted]'
  if (depth > 20) return '[depth limit]'
  if (value instanceof Error) return { name: value.name, message: traceData(value.message), stack: traceData(value.stack) }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[binary: ${value.byteLength} bytes]`
  if (Array.isArray(value)) return value.map((item) => key === 'images' && typeof item === 'string' && !/^(https?:|file:|[/\\]|[a-z]:)/i.test(item)
    ? `[image: ${item.length} encoded characters]` : traceData(item, '', depth + 1))
  if (value && typeof value === 'object' && /thinking|reasoning/.test(value.type ?? '')) return { type: value.type, content: '[omitted]' }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name,
    name === 'data' && /^(base64|image|audio)$/.test(value.type ?? '') ? '[binary omitted]' : traceData(item, name, depth + 1)]))
  if (typeof value !== 'string') return typeof value === 'bigint' ? String(value) : value
  if (/^data:[^,]+;base64,/i.test(value)) return `[data URI: ${value.length} characters]`
  let text = value.replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [redacted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key omitted]')
    .replace(/\b(?:sk-(?:ant|proj)-|gh[pousr]_|github_pat_)[\w-]{10,}/g, '[redacted]')
    .replace(/\b((?:[\w]+[_-])*(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|cookie|authorization|remote[_-]?code))\s*[:=]\s*["']?[^\s"',;}]+/gi, '$1=[redacted]')
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
    try {
      const url = new URL(raw)
      if (!url.username && !url.password && ![...url.searchParams.keys()].some((name) => secret.test(name))) return raw
      url.username = ''; url.password = ''
      for (const name of url.searchParams.keys()) if (secret.test(name)) url.searchParams.set(name, '[redacted]')
      return url.href
    } catch { return raw }
  })
  if (/^\s*[{[]/.test(text)) {
    try { text = JSON.stringify(traceData(JSON.parse(text), '', depth + 1)) } catch { /* ordinary text */ }
  }
  return text.length > 262144 ? `${text.slice(0, 262144)}\n[truncated: ${text.length} characters total]` : text
}

export function createTrace({ write, context = {}, now = () => new Date(), onError = () => {} }) {
  let pending = Promise.resolve()
  const scope = (fields) => ({
    record(event, data = {}) {
      try {
        const line = JSON.stringify({ time: now().toISOString(), ...fields, event, data: traceData(data) }) + '\n'
        pending = pending.then(() => write(line)).catch(onError)
      } catch (error) { onError(error) }
      return pending
    },
    child(more) { return scope({ ...fields, ...traceData(more) }) },
    flush() { return pending },
  })
  return scope({ sessionId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, ...traceData(context) })
}

/** Traces switched off: nothing is serialized and nothing is written. */
export const noTrace = Object.freeze({
  record: () => Promise.resolve(),
  child: () => noTrace,
  flush: () => Promise.resolve(),
})
