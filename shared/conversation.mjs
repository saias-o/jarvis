const encoder = new TextEncoder()
const bytes = (value) => encoder.encode(JSON.stringify(value)).length
export const UNCONFIRMED_RESULT = 'Outcome unconfirmed. Verify the current state before retrying.'

export function excerpt(value, limit) {
  if (value.length <= limit) return value
  const half = Math.floor(limit / 2)
  return value.slice(0, half) + '\n[…]\n' + value.slice(-half)
}

function compactCall(call, limit) {
  const fn = call?.function
  if (!fn || !fn.arguments) return call
  const shorten = (value) => typeof value === 'string' ? excerpt(value, limit) : value
  // Keep named arguments (including paths) even if a file body is huge.
  let args = fn.arguments
  if (typeof args === 'object') {
    args = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, shorten(value)]))
  } else {
    args = shorten(args)
  }
  return { ...call, function: { ...fn, arguments: args } }
}

function compact(exchange, limit) {
  const copy = { ...exchange, user: excerpt(exchange.user, limit), jarvis: excerpt(exchange.jarvis, limit) }
  if (exchange.messages) {
    copy.messages = exchange.messages.map((message) => {
      const reduced = { ...message, content: excerpt(message.content, limit) }
      if (message.tool_calls) reduced.tool_calls = message.tool_calls.map((call) => compactCall(call, limit))
      return reduced
    })
  }
  return copy
}

/** Retained conversation data, never system roles. Old clients omit the exchange id. */
export function retainedHistory(raw, maxBytes = 256 * 1024) {
  if (!Array.isArray(raw)) return []
  const kept = []
  let size = 0
  for (const exchange of raw.slice(-40).reverse()) {
    if (typeof exchange?.user !== 'string' || typeof exchange.jarvis !== 'string') continue
    let copy = { user: exchange.user, jarvis: exchange.jarvis }
    if (typeof exchange.id === 'string' && /^[\w-]{1,80}$/.test(exchange.id)) copy.id = exchange.id
    if (exchange.messages !== undefined) {
      if (!Array.isArray(exchange.messages) || exchange.messages.length > 128 ||
          !exchange.messages.every((m) => ['user', 'assistant', 'tool'].includes(m?.role) && typeof m.content === 'string')) continue
      copy.messages = exchange.messages.map(({ role, content, tool_name, tool_calls }) => ({
        role, content,
        ...(typeof tool_name === 'string' ? { tool_name } : {}),
        ...(Array.isArray(tool_calls) ? { tool_calls } : {}),
      }))
    }
    let length = bytes(copy)
    if (length > maxBytes) {
      for (const limit of [2048, 512, 128]) {
        copy = compact(copy, limit)
        length = bytes(copy)
        if (length <= maxBytes / 2) break
      }
      if (length > maxBytes) continue
    }
    if (size + length > maxBytes) break
    size += length
    kept.unshift(copy)
  }
  return kept
}

/** One retention rule for the PC, the phone and transport reconnections. */
export function appendExchange(history, exchange) {
  const index = exchange.id ? history.findIndex((entry) => entry.id === exchange.id) : -1
  const updated = history.slice()
  if (index < 0) updated.push(exchange)
  else updated[index] = exchange
  history.splice(0, history.length, ...retainedHistory(updated))
  return history
}
