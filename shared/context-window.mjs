const encoder = new TextEncoder()
const bytes = (value) => encoder.encode(JSON.stringify(value)).length

function excerpt(text, limit) {
  if (text.length <= limit) return text
  return text.slice(0, limit) + '\n[Earlier tool output shortened to fit the local model; do not repeat completed actions.]'
}

/** Keep current tool results and the request; discard old conversation first. */
export function fitContext(messages, tools, maxBytes = 6144) {
  const current = messages.findLastIndex((message) => message.role === 'user')
  const system = messages.filter((message) => message.role === 'system')
  const earlier = messages.slice(system.length, current)
  const turn = messages.slice(current).map((message) => ({ ...message }))
  const cost = () => bytes([system, earlier, turn, tools])

  while (earlier.length && cost() > maxBytes) {
    earlier.shift()
    while (earlier.length && earlier[0].role !== 'user') earlier.shift()
  }
  // Old tool payloads are context, never actions to execute again. Retain their
  // names and call arguments, and keep the newest tool response intact.
  const latestTool = turn.findLastIndex((message) => message.role === 'tool')
  for (const limit of [512, 128]) {
    for (let i = 0; i < latestTool && cost() > maxBytes; i++) {
      if (turn[i].role === 'tool') turn[i].content = excerpt(turn[i].content, limit)
    }
  }
  if (cost() > maxBytes) throw new Error('Le résultat est trop volumineux pour Gemma. Demandez une lecture plus courte ou une liste de fichiers plus précise.')
  return [...system, ...earlier, ...turn]
}

export function contextOverflow(error) {
  return /input token ids.*too long|maximum number of tokens|context.*exceed/i.test(String(error?.message ?? error))
}

/** A rejected input can be compacted; streamed output must never be replayed. */
export async function* boundedChat(chat, messages, tools, signal) {
  const budgets = [6144, 4608, 3584]
  for (let attempt = 0; attempt < budgets.length; attempt++) {
    signal?.throwIfAborted()
    const fitted = fitContext(messages, tools, budgets[attempt])
    let produced = false
    try {
      for await (const chunk of chat(fitted, tools, signal)) {
        signal?.throwIfAborted()
        if (chunk.message?.content || chunk.message?.tool_calls?.length) produced = true
        yield chunk
      }
      return
    } catch (error) {
      if (!contextOverflow(error)) throw error
      if (produced || attempt === budgets.length - 1)
        throw new Error('Gemma a atteint sa limite de contexte. Reformulez brièvement la demande.', { cause: error })
    }
  }
}
