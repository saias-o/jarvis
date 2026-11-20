/**
 * What the bridge pushes at the interface, wired to the store.
 *
 * Every channel here is the bridge volunteering something mid-turn — servers,
 * panels, interface commands, which brain is answering, the connection — plus
 * the one request it makes of us, a camera frame. One call subscribes to all
 * of them and returns the one call that removes them, so an app that goes away
 * leaves no handler behind and an app that comes back holds exactly one each.
 */
import { useStore } from '../store'
import * as camera from './camera'
import { applyUiOp } from './uiOps'
import {
  watchBlades,
  watchBrain,
  watchCapture,
  watchConnection,
  watchServers,
  watchUi,
} from './brain'
import type { CaptureRequest, CaptureResult } from './bridge'

/**
 * JARVIS asking to see something.
 *
 * Announced on screen for as long as it takes, with whatever he said he was
 * looking for. The camera's own light is on too, but a hardware light that
 * appears with no explanation is exactly the thing that makes people
 * distrust an assistant — so the interface says it before they have to ask.
 */
async function capture(req: CaptureRequest): Promise<CaptureResult> {
  const note =
    req.mode === 'watch'
      ? req.when === 'past'
        ? req.reason || 'reviewing the last few seconds'
        : `${req.reason || 'watching'} · ${req.seconds}s`
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
    if (req.mode === 'look') return camera.grabFrame()
    if (req.when === 'past') {
      const grid = camera.recentGrid(req.seconds, 9)
      return grid ?? { error: 'There is not enough recent footage to review.' }
    }
    return await camera.watchAhead(req.seconds, 9)
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

/** Subscribe the interface to the bridge; returns the unsubscribe. */
export function connectBridgeEvents(): () => void {
  const store = useStore.getState
  const off = [
    watchServers((servers) => store().setConnected(servers)),
    watchBlades((blade) => store().pushBlade(blade)),
    watchCapture(capture),
    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi(applyUiOp),
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchBrain((brain) => store().setBrain(brain)),
    watchConnection((state) => {
      if (state === 'lost') store().setError('Bridge connection lost — reconnecting.')
      else if (state === 'reconnected') store().setError('Bridge reconnected.')
    }),
  ]
  return () => off.forEach((stop) => stop())
}
