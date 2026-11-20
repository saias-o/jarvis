/** No actions run on the server. Tool proposals go back to the caller's loop. */
export const INFERENCE_MAX_BYTES = 256 * 1024
export const INFERENCE_MAX_MESSAGES = 160
/** At most this many camera frames reach the PC, newest first. */
export const INFERENCE_MAX_IMAGES = 2

const NO_ROOM = 'La demande et ses outils dépassent la capacité de l’inférence PC.'
/** Said in the model's own observation, so it knows the picture is missing
 *  rather than silently describing one it was never shown. */
const DROPPED = '\n[image non transmise : la demande dépassait la capacité de l’inférence PC]'

/**
 * The frames worth sending.
 *
 * A camera frame rides with the tool result that produced it, and the loop
 * keeps that message for the rest of the turn — so a second look leaves the
 * first one in the request, paying for a picture the model has already
 * described. Only the newest frames go, which is also the only part the body's
 * 256 kB has room for.
 */
function newestImages(messages) {
  const carrying = messages.filter((message) => message.images?.length)
  const keep = new Set(carrying.slice(-INFERENCE_MAX_IMAGES))
  if (keep.size === carrying.length) return messages
  return messages.map((message) => (message.images?.length && !keep.has(message)
    ? { ...message, images: undefined }
    : message))
}

/** The same conversation without any picture, each stripped result saying so. */
const withoutImages = (messages) => messages.map((message) => (message.images?.length
  ? { ...message, images: undefined, content: `${message.content ?? ''}${DROPPED}` }
  : message))

const serialise = (messages, tools, trace) => {
  const sent = messages.map(({ images, ...message }) => (images?.length ? { ...message, images } : message))
  return JSON.stringify({ messages: sent, tools, ...(trace ? { trace } : {}) })
}

function requestBody(messages, tools, trace) {
  // Pictures first: dropping an old frame costs nothing, where dropping an
  // exchange costs the model the result it was working from.
  let history = newestImages(messages)
  let stripped = false
  while (true) {
    const body = serialise(history, tools, trace)
    if (history.length <= INFERENCE_MAX_MESSAGES && new TextEncoder().encode(body).length <= INFERENCE_MAX_BYTES) return body
    const firstUser = history.findIndex((message) => message.role === 'user')
    const nextUser = history.findIndex((message, index) => index > firstUser && message.role === 'user')
    if (firstUser < 0 || nextUser < 0) {
      // Nothing left to drop but the frame of this very step. Answering
      // without it beats refusing the turn outright.
      if (stripped || !history.some((message) => message.images?.length)) throw new Error(NO_ROOM)
      history = withoutImages(history)
      stripped = true
      continue
    }
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
