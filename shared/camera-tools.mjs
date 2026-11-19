/**
 * JARVIS's eyes: `look` (one frame) and `watch` (a few seconds as a grid).
 *
 * Defined once for every model. A device supplies `capture(request)`, which
 * asks the screen that owns the camera for a frame and resolves with
 * { data, mimeType } (base64) or { error }. On the PC it travels the socket to
 * the browser; a device whose models cannot see images does not supply it, and
 * these tools are then not offered there.
 *
 * The result is { text, images: [{ type: 'image', data, mimeType }] }: the
 * shared loop hands the image to the model with the tool result, the MCP
 * adapter turns it into image content for Claude. No frame is stored.
 *
 * Three things keep this honest: the operating system's camera permission,
 * the indicator on screen for as long as the camera is live, and the guide
 * below telling the model to look only when asked to.
 *
 * Browser-safe.
 */

const LOOK_GUIDE = `Use it when the user asks you to look — "what am I holding", "how do I look",
"is anyone behind me", "read this label", "what colour is this". Anything where
the answer is in front of the camera rather than on the machine.

Do NOT use it speculatively. It switches on a camera pointed at their face, and
the indicator and the hardware light both come on. Take a picture because they
asked you to take a picture, not because a picture might be informative.

One frame per question. If you need to see something again after they have
moved or turned it around, take another — do not ask them to hold still while
you reason about a picture you already have.`

const WATCH_GUIDE = `Returns a grid of frames from a few seconds of video, in order, each stamped
with its offset. That is how motion becomes something you can actually read: one
still tells you what is there, a grid tells you what CHANGED.

Use it when the answer is in the movement rather than the moment — "am I doing
this right", "what am I doing wrong", "watch my form", "did that work", "what
just happened". Anything where a single photograph would miss the point.

Two directions, and choosing correctly matters:
  now  — record the next few seconds. For "watch me do this", where the thing
         has not happened yet when they ask.
  past — the seconds that have ALREADY happened. For "what did I just do",
         which cannot be answered by starting to record when asked. Only works
         while the camera is open on screen; if it is not, say so and offer to
         open it and watch again.

Keep it short. Six seconds is usually plenty, and a longer window spreads the
same number of frames thinner rather than showing you more.

Describe what you saw as a sequence — what changed between the frames — rather
than listing them. The user knows what their own hands look like.`

/** The names of these tools, for adapters that carry them under their own server. */
export const CAMERA_TOOLS = new Set(['look', 'watch'])

const reasonOf = (value) => String(value ?? '').slice(0, 80)

/**
 * @param {(request: object) => Promise<{ data?: string, mimeType?: string, error?: string }>} capture
 */
export function cameraTools(capture) {
  /** A denied camera is a fact about the machine, worded so it can be passed on as one sentence. */
  async function frame(request, intro, unreachable) {
    let reply
    try { reply = await capture(request) }
    catch (error) { throw new Error(`${unreachable}: ${error?.message ?? error}. Tell the user and carry on without it.`) }
    if (reply?.error) throw new Error(String(reply.error))
    if (typeof reply?.data !== 'string' || !reply.data) throw new Error('The camera returned nothing.')
    return { text: intro, images: [{ type: 'image', data: reply.data, mimeType: reply.mimeType ?? 'image/jpeg' }] }
  }
  return [
    {
      name: 'look',
      forgiving: true,
      description: 'Look through the camera at whoever is in front of the screen: one frame you can see. Only when asked to look.',
      guide: LOOK_GUIDE,
      parameters: { type: 'object', required: [], properties: {
        reason: { type: 'string', description: 'What you are looking for, shown while the camera is live.' },
      } },
      run: (input = {}) => frame({ mode: 'look', reason: reasonOf(input.reason) }, 'One frame from the camera:', 'Could not reach the camera'),
    },
    {
      name: 'watch',
      forgiving: true,
      description: 'Watch through the camera over a few seconds (now = next seconds, past = the seconds just gone): a grid of frames in order.',
      guide: WATCH_GUIDE,
      parameters: { type: 'object', required: [], properties: {
        seconds: { type: 'number', description: '2 to 15, default 6.' },
        when: { type: 'string', enum: ['now', 'past'] },
        reason: { type: 'string', description: 'What you are watching for, shown on screen.' },
      } },
      run: (input = {}) => frame({
        mode: 'watch',
        seconds: Math.min(15, Math.max(2, Number(input.seconds) || 6)),
        when: input.when === 'past' ? 'past' : 'now',
        reason: reasonOf(input.reason),
      }, 'Frames from the camera, in order, each stamped with its time offset in seconds. Read them left to right, top to bottom: they are one continuous clip, not separate pictures.',
      'Could not watch'),
    },
  ]
}
