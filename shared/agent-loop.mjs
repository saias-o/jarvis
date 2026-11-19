/** Browser-safe agent loop shared by Ollama and the Android runtime. */
import { excerpt, UNCONFIRMED_RESULT } from './conversation.mjs'

/** Tool arguments are an object in Ollama's API; some models still send a string. */
function parseArgs(raw) {
  const args = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected an object of tool arguments')
  return args
}

export async function agentTurn(text, {
  chat, system = '', history = [], tools = [], images = [], signal,
  onText, onTool, onMessages, onCheckpoint, onProgress, trace, observations = [], maxSteps = 6,
}) {
  signal?.throwIfAborted()
  maxSteps = Math.max(1, Math.min(12, Math.floor(maxSteps) || 6))
  const messages = [
    { role: 'system', content: system ?? '' },
    ...history.flatMap((exchange) => exchange.messages?.map(({ thinking: _thinking, ...message }) => ({ ...message })) ?? [
      { role: 'user', content: String(exchange.user ?? '') },
      { role: 'assistant', content: String(exchange.jarvis ?? '') },
    ]),
    { role: 'user', content: text, ...(images.length ? { images } : {}) },
    ...observations.map((message) => ({ ...message })),
  ]
  const specs = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
  const byName = new Map(tools.map((t) => [t.name, t]))
  const said = []
  const turnStart = messages.length - observations.length - 1
  const snapshot = () => messages.slice(turnStart).map(({ thinking: _thinking, images: _images, ...message }) => ({ ...message }))

  for (let step = 0; step < maxSteps; step++) {
    signal?.throwIfAborted()
    // The last call gets no tools, so a model that would rather keep looking
    // things up for ever has to say something instead.
    const offer = step < maxSteps - 1 ? specs : []
    await trace?.('model.request', { step, messages, tools: offer })
    let content = ''
    let thinking = ''
    const calls = []
    const stream = chat(messages, offer, signal)
    try {
      for await (const chunk of stream) {
        onProgress?.()
        const message = chunk.message ?? {}
        if (message.thinking) thinking += message.thinking
        if (message.content) {
          content += message.content
          onText?.(message.content)
        }
        if (Array.isArray(message.tool_calls)) calls.push(...message.tool_calls)
      }
    } catch (error) { await trace?.('model.error', { step, error }); throw error }
    await trace?.('model.response', { step, content, calls })
    if (content.trim()) said.push(content.trim())
    const reply = {
      role: 'assistant',
      content,
      ...(thinking ? { thinking } : {}),
    }
    messages.push(reply)
    signal?.throwIfAborted()
    if (!calls.length || !offer.length) break

    for (const [index, call] of calls.entries()) {
      signal?.throwIfAborted()
      const name = String(call?.function?.name ?? '')
      const tool = byName.get(name)
      const callId = globalThis.crypto?.randomUUID?.() ?? `${step}-${calls.indexOf(call)}`
      const args = call?.function?.arguments
      const started = Date.now()
      await trace?.('tool.start', { callId, name, arguments: args, available: Boolean(tool) })
      let result
      let error
      // Only record calls reached so far. An interruption can strand the rest of a batch.
      reply.tool_calls = calls.slice(0, index + 1)
      if (!tool) {
        result = `There is no tool called ${name}.`
      } else {
        onTool?.(name)
        try {
          signal?.throwIfAborted()
          const parsed = parseArgs(args)
          onCheckpoint?.([...snapshot(), { role: 'tool', tool_name: name, content: UNCONFIRMED_RESULT }])
          result = await tool.run(parsed, { signal })
        } catch (err) {
          error = err
          result = `That failed: ${err?.message ?? err}. Verify any possible side effects before retrying.`
        }
      }
      // A tool can return what it saw: { text, images }. The picture rides with
      // the result for this turn only; the snapshot kept in history drops it.
      const seen = result && typeof result === 'object' && Array.isArray(result.images) ? result : null
      messages.push({ role: 'tool', tool_name: name, content: excerpt(String(seen ? seen.text ?? '' : result ?? ''), 6000),
        ...(seen?.images.length ? { images: seen.images.map((image) => image.data) } : {}) })
      onCheckpoint?.(snapshot())
      await trace?.('tool.result', { callId, name, result, error, durationMs: Date.now() - started, cancelled: signal?.aborted ?? false })
      signal?.throwIfAborted()
    }
  }
  // Retain observations as well as speech. A later turn needs paths returned
  // by uploads and the outcomes of completed actions, not just their summary.
  onMessages?.(snapshot())
  return said.join(' ')
}
