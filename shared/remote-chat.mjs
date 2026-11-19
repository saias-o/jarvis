/** No actions run on the server. Tool proposals go back to the caller's loop. */
export const INFERENCE_MAX_BYTES = 256 * 1024
export const INFERENCE_MAX_MESSAGES = 160

function requestBody(messages, tools, trace) {
  let history = messages
  while (true) {
    const body = JSON.stringify({ messages: history, tools, ...(trace ? { trace } : {}) })
    if (history.length <= INFERENCE_MAX_MESSAGES && new TextEncoder().encode(body).length <= INFERENCE_MAX_BYTES) return body
    const firstUser = history.findIndex((message) => message.role === 'user')
    const nextUser = history.findIndex((message, index) => index > firstUser && message.role === 'user')
    if (firstUser < 0 || nextUser < 0) throw new Error('La demande et ses outils dépassent la capacité de l’inférence PC.')
    history = [...history.slice(0, firstUser), ...history.slice(nextUser)]
  }
}

export async function* remoteChat(fetcher, url, messages, tools, signal, trace) {
  signal?.throwIfAborted()
  const response = await fetcher(`${url}/inference`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: requestBody(messages, tools, trace), signal,
  })
  if (!response.ok) throw new Error(response.status === 401
    ? 'Accès au PC refusé. Vérifiez les réglages Android.'
    : `Inférence PC indisponible (${response.status}). Réessayez ou choisissez Gemma.`)
  const result = await response.json()
  signal?.throwIfAborted()
  if (typeof result?.message?.content !== 'string' || !Array.isArray(result.message.tool_calls) ||
      result.message.tool_calls.some((call) => !tools.some((t) => t.function.name === call?.function?.name) ||
        !call.function.arguments || typeof call.function.arguments !== 'object' || Array.isArray(call.function.arguments))) {
    throw new Error('Réponse d’inférence PC invalide.')
  }
  yield { message: result.message }
}
