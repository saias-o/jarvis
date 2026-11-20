import { AndroidSettings } from './ui/AndroidSettings'
import { isAndroid } from './lib/android'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { AccessGate } from './ui/Access'
import { Talk } from './ui/Talk'
import { Ask } from './ui/Ask'
import { Drop } from './ui/Drop'
import { takeAttachments } from './lib/upload'
import { useStore } from './store'
import { startVoice } from './lib/voice'
import { withoutVocative } from '../shared/wake-phrase.mjs'
import { createSpeaker, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE, BRIDGE_IS_HOST, BOOT_SEQUENCE, env } from './config'
import { checkAccess, type Access } from './lib/access'
import { keepScreenOn } from './lib/wakelock'
import { forTool, attention } from './lib/fillers'
import { ask, warm, cancel, connectedLabels, usingBridge } from './lib/brain'
import { startAnalyser, micLevel } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { createTurns } from './lib/turns'
import { createListening, onFirstGesture } from './lib/listening'
import { connectBridgeEvents } from './lib/bridgeEvents'
import { bindShortcuts } from './lib/shortcuts'
import { receiveShares } from './lib/androidShares'

/**
 * The reactor, fetched rather than carried.
 *
 * Three, the fibre renderer and the post-processing chain are the largest
 * thing in the bundle by some way, and nothing can be said or heard until they
 * have been parsed — on a phone, on the first load, that is the slowest
 * machine doing the heaviest parse before the interface will answer at all.
 * Behind a lazy boundary they arrive in their own chunk, in parallel with the
 * rest of the app starting up.
 *
 * The fallback is nothing, deliberately: the page's own background is already
 * painted, the reactor spends its first second as a sealed ring that has not
 * been powered on, and an orb arriving a few hundred milliseconds into the
 * boot sequence is indistinguishable from one that was always there.
 */
const Scene = lazy(() => import('./scene/Scene').then(({ Scene: component }) => ({ default: component })))

/**
 * The app: one lifetime of the interface.
 *
 * The conversation itself is the state machine in lib/turns.ts, the
 * microphone's lifetime is lib/listening.ts and the bridge's pushes are
 * lib/bridgeEvents.ts. This component starts them, and stops every one of them
 * when it goes away: a remount holds one microphone and one subscription each.
 */

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** Thrown out of a boot whose app has gone away; never reported. */
const GONE = Symbol('gone')

export default function App() {
  const phase = useStore((s) => s.phase)

  const [turns] = useState(() =>
    createTurns({
      state: useStore.getState,
      ask,
      cancel,
      speaker: createSpeaker,
      takeFiles: () => (usingBridge ? takeAttachments() : []),
      keepHistory: !usingBridge,
      sounds: sfx,
      music,
      forTool,
      attention,
      withoutVocative,
      newId,
    }),
  )
  const [listening] = useState(() =>
    createListening(
      startVoice,
      {
        mode: turns.mode,
        onWake: turns.onWake,
        onSpeechStart: turns.onSpeechStart,
        onPartial: turns.onPartial,
        onUtterance: turns.onUtterance,
        onError: turns.onError,
      },
      // The analyser is what makes the reactor pulse with your voice. Android's
      // native recognizer owns the microphone: a second WebView capture can
      // prevent it from hearing anything on some phones.
      isAndroid ? undefined : startAnalyser,
    ),
  )

  const booting = useRef(false)
  const gone = useRef(false)
  /** What this lifetime started besides the turns and the microphone. */
  const teardown = useRef<Array<() => void>>([])

  /**
   * Whether this device may talk to the bridge at all. Only ever in doubt when
   * the bridge itself served the page — a phone, over the remote port — and
   * until it is settled the ignition does nothing, since a power-up that
   * cannot open the socket is just an error message with a boot animation.
   */
  const [access, setAccess] = useState<Access>(BRIDGE_IS_HOST ? 'checking' : 'open')
  const accessNow = useRef(access)
  accessNow.current = access
  useEffect(() => {
    if (BRIDGE_IS_HOST) void checkAccess().then((a) => { if (!gone.current) setAccess(a) })
  }, [])

  // -- power on -------------------------------------------------------------

  /** Between the awaits of a boot: stop if the app went away meanwhile. */
  const alive = () => {
    if (gone.current) throw GONE
  }

  const armVoice = () =>
    listening.arm().catch((err) =>
      turns.onError(err instanceof Error ? err.message : 'Voice input failed to start.'),
    )

  const ignite = async () => {
    const s = useStore.getState()

    if (BOOT_SEQUENCE) {
      // Must happen inside the click handler — browsers won't start an
      // AudioContext or speech synthesis without a user gesture.
      await sfx.unlockAudio()
      sfx.play('boot')
      // Also has to be asked for from inside the gesture.
      keepScreenOn()
      // The score. Must be started from inside this click handler for the same
      // reason as the rest of the audio.
      music.enable()
      music.playBoot()
      music.startAmbient()
    }

    s.setPhase('boot')
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      const poll = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          useStore.getState().setBootNote('')
          clearInterval(poll)
        } else if (p > 0 && p < 1) {
          useStore.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
      teardown.current.push(() => clearInterval(poll))
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, suit schematic, reactor power-up — before the live
    // interface takes over. Only when the sequence was asked for: by default
    // nothing here waits on anything but the bridge.
    if (BOOT_SEQUENCE) await new Promise((r) => setTimeout(r, 9200))
    await warming
    alive()
    useStore.getState().setConnected(connectedLabels())

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload. The HUD label is set only
    // after this resolves, or it always reports the browser fallback voice
    // even when ElevenLabs is the one actually about to speak.
    await probeCapabilities()
    alive()
    useStore.getState().setVoice(currentVoiceName())

    if (BOOT_SEQUENCE || isAndroid) {
      // Native speech asks for its Android permission itself and does not need
      // a browser gesture. Arm it at launch, including standby wake detection.
      await listening.arm()
      alive()
      useStore.getState().setVoiceReady(true)
    } else {
      // Without the ignition screen there is no click to hang the audio on, so
      // it waits for the first one the user makes for any reason. Until then
      // he is up, connected and answers what is typed; he just cannot hear or
      // be heard.
      useStore.getState().setVoiceReady(false)
      teardown.current.push(
        onFirstGesture(window, () => {
          void sfx.unlockAudio()
          keepScreenOn()
          music.enable()
          music.startAmbient()
          useStore.getState().setVoiceReady(true)
          void armVoice()
        }),
      )
    }

    useStore.getState().setPhase('dormant')
  }

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice.
    if (booting.current || gone.current || accessNow.current !== 'open') return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      if (err === GONE) return
      // The guard must not outlive a failed boot: reset it and put the button
      // back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      useStore.getState().setPhase('offline')
      useStore
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  /**
   * No ignition screen by default: come up as soon as the page may talk to the
   * bridge — at once on the computer, and the moment the code is accepted on a
   * device that still has to give one.
   */
  useEffect(() => {
    if (!BOOT_SEQUENCE && access === 'open') void powerOn()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access])

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button. Only while the
   * ignition screen is showing, and torn down the moment he boots — the
   * microphone is about to belong to the voice loop. Silent about failure: the
   * button is still right there.
   */
  useEffect(() => {
    if (phase !== 'offline' || !BOOT_SEQUENCE) return
    let live: { stop: () => void } | null = null
    let stopped = false
    void listenForClap(() => {
      if (!stopped) void powerOn()
    }).then((l) => {
      if (stopped) l.stop()
      else live = l
    })
    return () => {
      stopped = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- one lifetime: subscriptions, keys, level pump, and their end ---------

  useEffect(() => {
    // The boot pushes into this same array, after this line runs.
    const started = teardown.current
    const unsubscribe = connectBridgeEvents()
    const unbind = bindShortcuts(window, turns, () => void powerOn())
    const stopShares = receiveShares()

    let raf = 0
    const pump = () => {
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      useStore.getState().setLevel(turns.level() ?? micLevel())
      raf = requestAnimationFrame(pump)
    }
    pump()

    return () => {
      gone.current = true
      cancelAnimationFrame(raf)
      unsubscribe()
      unbind()
      stopShares()
      for (const stop of started.splice(0)) stop()
      listening.stop()
      turns.dispose()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <AndroidSettings />
      <Suspense fallback={null}>
        <Scene />
      </Suspense>
      <Hud />
      {BOOT_SEQUENCE && <Boot />}
      <Diagnostics />
      <Ask onSend={turns.sendText} />
      <Drop />
      <Talk onPress={turns.talk} />
      {BOOT_SEQUENCE && <Ignition onStart={() => void powerOn()} />}
      {access === 'locked' && <AccessGate onOpen={() => setAccess('open')} />}
    </>
  )
}
