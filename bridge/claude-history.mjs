/** Translate SDK records into the conversation format used by every brain. */
import { UNCONFIRMED_RESULT } from '../shared/conversation.mjs'
const textOf = (content) => typeof content === 'string' ? content : (content ?? [])
  .filter((block) => block.type === 'text').map((block) => block.text).join('\n')

export function recordClaudeMessage(messages, event) {
  if (event.error) return
  const blocks = event.message?.content ?? event.content
  if (event.type === 'assistant' && Array.isArray(blocks)) {
    const calls = blocks.filter((block) => block.type === 'tool_use').map((block) => ({
      id: block.id, function: { name: block.name, arguments: block.input },
    }))
    const content = textOf(blocks)
    if (content || calls.length) messages.push({ role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) })
    for (const call of calls) {
      messages.push({ role: 'tool', tool_call_id: call.id, tool_name: call.function.name, content: UNCONFIRMED_RESULT })
    }
    return calls.length > 0
  }
  if (event.type === 'user' && Array.isArray(blocks)) {
    const results = blocks.filter((block) => block.type === 'tool_result')
    for (const block of results) {
      const pending = messages.find((message) => message.role === 'tool' && message.tool_call_id === block.tool_use_id)
      const content = `${block.is_error ? 'That failed: ' : ''}${textOf(block.content)}`
      if (pending) pending.content = content
      else messages.push({ role: 'tool', tool_name: 'tool', content })
    }
    return results.length > 0
  }
}
