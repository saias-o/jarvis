/**
 * What the bridge pushes at the interface, wired to the store.
 *
 * Every channel here is the bridge volunteering something mid-turn — servers,
 * panels, interface commands, which brain is answering, the connection — plus
 * the one request it makes of us, a camera frame, answered by the shared
 * primitive in capture.ts (the phone calls that same one without a socket).
 *
 * One call subscribes to all of them and returns the one call that removes
 * them, so an app that goes away leaves no handler behind and an app that
 * comes back holds exactly one each.
 */
import { useStore } from '../store'
import { capture } from './capture'
import { applyUiOp } from './uiOps'
import {
  watchBlades,
  watchBrain,
  watchCapture,
  watchConnection,
  watchServers,
  watchUi,
} from './brain'

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
