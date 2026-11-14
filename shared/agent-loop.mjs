/** Browser-safe agent loop shared by Ollama and the Android runtime. */
const clip = (text, max) => {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** Tool arguments are an object in Ollama's API; some models still send a string. */
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function agentTurn(text, {
  chat, system = '', history = [], tools = [], images = [], signal,
  onText, onTool, maxSteps = 6,
}) {
  signal?.throwIfAborted()
  maxSteps = Math.max(1, Math.min(12, Math.floor(maxSteps) || 6))
  const messages = [
    { role: 'system', content: system ?? '' },
    ...history.flatMap((exchange) => [
      { role: 'user', content: clip(exchange.user, 1200) },
      { role: 'assistant', content: clip(exchange.jarvis, 1200) },
    ]),
    { role: 'user', content: text, ...(images.length ? { images } : {}) },
  ]
  const specs = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
  const byName = new Map(tools.map((t) => [t.name, t]))
  const said = []

  for (let step = 0; step < maxSteps; step++) {
    signal?.throwIfAborted()
    // The last call gets no tools, so a model that would rather keep looking
    // things up for ever has to say something instead.
    const offer = step < maxSteps - 1 ? specs : []
    let content = ''
    const calls = []
    const stream = chat(messages, offer, signal)
    for await (const chunk of stream) {
      const message = chunk.message ?? {}
      if (message.content) {
        content += message.content
        onText?.(message.content)
      }
      if (Array.isArray(message.tool_calls)) calls.push(...message.tool_calls)
    }
    if (content.trim()) said.push(content.trim())
    messages.push({
      role: 'assistant',
      content,
      ...(calls.length ? { tool_calls: calls } : {}),
    })
    signal?.throwIfAborted()
    if (!calls.length || !offer.length) break

    for (const call of calls) {
      signal?.throwIfAborted()
      const name = String(call?.function?.name ?? '')
      const tool = byName.get(name)
      let result
      if (!tool) {
        result = `There is no tool called ${name}.`
      } else {
        onTool?.(name)
        try {
          result = await tool.run(parseArgs(call.function.arguments), { signal })
        } catch (err) {
          result = `That failed: ${err?.message ?? err}`
        }
      }
      signal?.throwIfAborted()
      messages.push({ role: 'tool', tool_name: name, content: clip(result, 6000) })
    }
  }
  return said.join(' ')
}
