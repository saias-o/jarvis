/** No actions run on the server. Tool proposals go back to the caller's loop. */
export async function* remoteChat(fetcher, url, messages, tools, signal) {
  signal?.throwIfAborted()
  const response = await fetcher(`${url}/inference`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, tools }), signal,
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
