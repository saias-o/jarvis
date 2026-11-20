/**
 * The one camera primitive of the interface.
 *
 * `look` and `watch` are defined once in shared/camera-tools.mjs for every
 * model; this is the thing underneath them on the device that owns the screen.
 * It belongs here rather than in bridgeEvents.ts because both devices need it:
 * on the PC the bridge asks for a frame down the socket, and on the phone the
 * WebView runs the agent loop itself and calls this directly.
 *
 * The announcement on screen, the refusal when there is no recent footage and
 * the refcounted hold on the stream are the same either way — they are facts
 * about the camera and the person in front of it, not about who is thinking.
 */
import { useStore } from '../store'
import * as camera from './camera'
import type { CaptureResult } from './bridge'

/** Frames in a grid. Enough to read a movement, few enough to stay legible. */
const FRAMES = 9

/**
 * What a camera tool asks for. Looser than the bridge's own frame: `look`
 * sends a mode and a reason and nothing else, and the shared tools normalise
 * the rest, so the defaults live here rather than at four call sites.
 */
export type CameraRequest = {
  mode: 'look' | 'watch'
  reason?: string
  /** For a watch; 2 to 15 by the tool's own schema. */
  seconds?: number
  /** 'now' records forward; 'past' reads the rolling buffer. */
  when?: 'now' | 'past'
}

/**
 * JARVIS asking to see something.
 *
 * Announced on screen for as long as it takes, with whatever he said he was
 * looking for. The camera's own light is on too, but a hardware light that
 * appears with no explanation is exactly the thing that makes people
 * distrust an assistant — so the interface says it before they have to ask.
 *
 * @param maxWidth  Width ceiling in pixels for the returned image, or 0 for
 *   full size. The phone sets one: its frame travels to the PC inside an HTTP
 *   body that also carries the conversation and every schema, where the PC's
 *   own socket has no such limit.
 */
export async function capture(req: CameraRequest, maxWidth = 0): Promise<CaptureResult> {
  const seconds = Math.min(15, Math.max(2, Number(req.seconds) || 6))
  const note =
    req.mode === 'watch'
      ? req.when === 'past'
        ? req.reason || 'reviewing the last few seconds'
        : `${req.reason || 'watching'} · ${seconds}s`
      : req.reason || 'taking a look'
  useStore.getState().setLooking(note)

  // The past is only available if something has been remembering it, and
  // that only happens while the camera is on screen. Answering plainly
  // beats opening the camera and recording the next few seconds instead,
  // which is a different question from the one that was asked.
  if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
    useStore.getState().setLooking(null)
    return {
      error:
        'There is no recent footage — the camera has to be open on screen ' +
        'for me to remember what just happened. Ask me to open the camera, ' +
        'and I can watch from then on.',
    }
  }

  // Held for the whole capture. Without this the stream can be torn down by
  // whoever else was using it half way through a six-second watch.
  let held = false
  try {
    await camera.holdCamera()
    held = true
    if (req.mode === 'look') return camera.grabFrame(maxWidth)
    if (req.when === 'past') {
      const grid = camera.recentGrid(seconds, FRAMES, maxWidth)
      return grid ?? { error: 'There is not enough recent footage to review.' }
    }
    return await camera.watchAhead(seconds, FRAMES, maxWidth)
  } catch (err) {
    return {
      error:
        (err as DOMException)?.name === 'NotAllowedError'
          ? 'The camera is not permitted, so I cannot see anything.'
          : `The camera could not be read: ${(err as Error)?.message ?? err}`,
    }
  } finally {
    if (held) camera.releaseCamera()
    useStore.getState().setLooking(null)
  }
}
