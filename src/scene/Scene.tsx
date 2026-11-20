import { useEffect, useMemo } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  EffectComposer,
  Bloom,
  ChromaticAberration,
  Vignette,
  Noise,
} from '@react-three/postprocessing'
import { BlendFunction } from 'postprocessing'
import * as THREE from 'three'
import { Core } from './Core'
import { Particles } from './Particles'
import { Orbits } from './Orbits'
import { isAndroid } from '../lib/android'
import { useStore, phaseColor, accentFor, type Phase } from '../store'

/**
 * Live, so the setting can be changed without reloading the page, and read
 * rather than subscribed to: both places that care are already inside a frame.
 */
const reducedMotion =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

/**
 * Phones draw a cheaper picture.
 *
 * The APK is the certain case; a phone browser is inferred from a coarse
 * pointer on a small screen, which also catches a tablet — and a tablet wants
 * the same mercy. Nothing here changes what is drawn, only how finely and with
 * how many passes.
 */
const onPhone =
  isAndroid ||
  (typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)').matches &&
    Math.min(screen.width, screen.height) < 820)

/**
 * Pixel ratio ceiling.
 *
 * Everything in this scene is soft additive light that then goes through a
 * bloom, so there is no edge anywhere for the extra samples to sharpen: 2.0
 * cost four times the fragments of 1.0 and bought a difference nobody has ever
 * been able to point to. 1.5 keeps a little headroom on a desktop retina
 * display; a phone, whose ratio is routinely 3, gets none.
 */
const DPR_MAX = onPhone ? 1 : 1.5

/**
 * Frames a second worth spending, by phase.
 *
 * The scene lerps everything every frame, so it never produces two identical
 * frames and can never be left to rest entirely. But the phases where nothing
 * is happening are also the phases where nothing moves faster than a slow
 * breath — the ring turns at a twelfth of a revolution a second in standby —
 * and sixty frames of that is thirty frames of waste, all day, which is where
 * this interface actually spends its life.
 */
const paceFor: Record<Phase, number> = {
  offline: 30,
  boot: 60,
  dormant: 30,
  waking: 60,
  listening: 30,
  thinking: 60,
  tooling: 60,
  speaking: 60,
}

/**
 * The ceiling while a blade is holding the frame.
 *
 * Not a freeze, which is what this looked like from the outside. A blade is
 * translucent, carries a backdrop blur, and at its largest still leaves eight
 * percent of the width and twelve of the height around it — so a stopped
 * canvas is a visibly stopped reactor in the margin, which reads as the app
 * having hung rather than as it being considerate.
 */
const BLADE_PACE = 30

/** Rings spin harder while JARVIS is working — reads as effort. */
const spinFor: Record<Phase, number> = {
  offline: 0.08, // barely turning — the machine is off
  boot: 3.2,
  dormant: 0.25,
  waking: 4.5,
  listening: 1.1,
  thinking: 2.8,
  tooling: 3.6,
  speaking: 1.4,
}

/**
 * Surface displacement amplitude. Both states where nothing is happening get
 * the calm figure: 'offline' is the quietest moment in the whole piece — the
 * reactor hasn't been powered on yet — so it must not be the most agitated
 * thing on screen.
 */
/*
 * Much lower than they were. At 0.13/0.26 on a unit sphere the displacement is
 * a quarter of the radius, which is not a reactor breathing — it is a potato.
 * The reference core is a clean circle whose surface only shimmers; the drama
 * belongs to the instrument rings around it, not to the silhouette.
 */
const AMP_CALM = 0.035
const AMP_LIVE = 0.085

/**
 * Everything the three children animate from, in one mutable object.
 *
 * These used to be render-time props, which had two consequences. The scene
 * subscribed to mic level, so the entire r3f tree reconciled sixty times a
 * second for numbers that never leave useFrame; and because they were only
 * delivered on a re-render, they were delivered late or — before the analyser
 * starts and `level` is a constant zero — not at all, which is why the ignition
 * screen never picked up its own spin rate.
 *
 * Nothing here belongs in React state. The scene is updated by mutation and
 * React only ever mounts it: Rig writes this object once per frame, the
 * children read it in their own useFrame. Children subscribe to the frame loop
 * before their parent does, so they are reading the previous frame's values —
 * one frame of lag on quantities that are all lerped anyway, and invisible.
 */
export type Drive = {
  color: THREE.Color
  /** 0..1 smoothed loudness, with an idle breath under it. */
  level: number
  /** Rotation multiplier for the drifting dust. */
  spin: number
  /** Target displacement amplitude for the core surface. */
  amp: number
  /** 0..1 power-up reveal — the ring assembles outwards from the centre. */
  open: number
  /**
   * The reactor slice of the ui state, already resolved and smoothed.
   *
   * Everything here is a no-op at UI_DEFAULTS: colour follows the phase exactly
   * as it always did, and the three multipliers sit at one.
   */
  reactor: {
    /** ui.reactor.color if set, otherwise the accent. */
    color: THREE.Color
    scale: number
    intensity: number
    /** Multiplier on the ring's own rotation rate. */
    spin: number
    /** 0 ring, 1 sphere, 2 wire — a number because it ends up in a uniform. */
    style: number
    visible: boolean
  }
}

/**
 * A colour target that only re-parses when the string actually changes.
 *
 * The colours in the ui slice are arbitrary CSS written by JARVIS, and
 * THREE.Color.set logs a warning for anything it cannot parse. Setting one
 * unconditionally per frame turns a single typo into sixty console lines a
 * second, which drowns everything else out during a demo.
 */
type Tint = { key: string; color: THREE.Color }

function aim(tint: Tint, css: string): THREE.Color {
  if (tint.key !== css) {
    tint.key = css
    tint.color.set(css)
  }
  return tint.color
}

const STYLE_INDEX = { ring: 0, sphere: 1, wire: 2 } as const

/**
 * The frame loop, driven by hand.
 *
 * The canvas is mounted with frameloop="never" and advanced from here, so the
 * scene can cost what the moment is worth instead of whatever the display
 * happens to offer. That cuts both ways: standby stops paying for sixty
 * frames of a ring turning at a twelfth of a revolution a second, and a 144 Hz
 * monitor stops being charged 144 frames of a shader authored for sixty.
 *
 * In this mode r3f takes the elapsed time from the caller — in SECONDS, since
 * that is what Clock.elapsedTime holds and what the shaders read. Counting
 * from the moment this mounts rather than from the page's own origin keeps the
 * first delta small; handing it performance.now() would open with a delta of
 * however long the page had been loading, and every lerp in the scene would
 * snap to its target on frame one, taking the power-up reveal with it.
 *
 * The state is read imperatively, as everything in here is: a subscription
 * would reconcile the tree to change a number that only ever leaves in a
 * uniform.
 */
function Pace() {
  const advance = useThree((s) => s.advance)

  useEffect(() => {
    const start = performance.now()
    let previous = 0
    let last = -Infinity
    // A smoothed estimate of the display's own period, so the slack below is
    // half a real frame rather than half an assumed one. Asking for exactly
    // 33.3 ms on a 60 Hz display means every other frame misses by a hair and
    // the achieved rate falls to twenty.
    let period = 1000 / 60
    let raf = 0

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const now = performance.now()
      if (previous) period += (now - previous - period) * 0.1
      previous = now

      const { phase, blades, expandedBlade } = useStore.getState()
      let fps = paceFor[phase]
      if (expandedBlade || blades.some((blade) => blade.size === 'full')) {
        fps = Math.min(fps, BLADE_PACE)
      }
      if (reducedMotion?.matches) fps = Math.min(fps, BLADE_PACE)

      if (now - last < 1000 / fps - period / 2) return
      last = now
      advance((now - start) / 1000)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [advance])

  return null
}

function Rig() {
  const drive = useMemo<Drive>(
    () => ({
      color: new THREE.Color(phaseColor.offline),
      level: 0,
      spin: spinFor.offline,
      amp: AMP_CALM,
      open: 0,
      reactor: {
        color: new THREE.Color(phaseColor.offline),
        scale: 1,
        intensity: 1,
        spin: 1,
        style: STYLE_INDEX.ring,
        visible: true,
      },
    }),
    [],
  )
  const target = useMemo<Tint>(() => ({ key: '', color: new THREE.Color() }), [])
  const reactorTarget = useMemo<Tint>(
    () => ({ key: '', color: new THREE.Color() }),
    [],
  )

  useFrame((state, dt) => {
    // Read imperatively rather than subscribing — see the note on Drive.
    const { phase, level, ui } = useStore.getState()

    // accentFor owns the accent -> palette -> phase resolution order. The scene
    // asking the store for the answer rather than working it out again is what
    // keeps the orb and the HUD from ever disagreeing about the colour.
    const accent = accentFor(phase, ui)
    drive.color.lerp(aim(target, accent), Math.min(1, dt * 2.5))

    const r = ui.reactor
    drive.reactor.color.lerp(
      aim(reactorTarget, r.color ?? accent),
      Math.min(1, dt * 2.5),
    )
    // Smoothed rather than assigned, so "make it twice the size" grows into
    // place instead of snapping. The style is the exception: it is a mode, and
    // easing between two of them would drag the picture through the third.
    const k = Math.min(1, dt * 5)
    drive.reactor.scale += (r.scale - drive.reactor.scale) * k
    drive.reactor.intensity += (r.intensity - drive.reactor.intensity) * k
    drive.reactor.spin += (r.spin - drive.reactor.spin) * k
    drive.reactor.style = STYLE_INDEX[r.style] ?? STYLE_INDEX.ring
    drive.reactor.visible = r.visible

    drive.spin += (spinFor[phase] - drive.spin) * Math.min(1, dt * 2)
    drive.amp = phase === 'dormant' || phase === 'offline' ? AMP_CALM : AMP_LIVE
    // Held shut until the reactor is powered on, so the ring builds itself out
    // of the centre on the ignition click rather than simply appearing.
    drive.open = phase === 'offline' ? 0.28 : phase === 'boot' ? 0.7 : 1.6

    // Idle breathing so the orb is never completely still.
    const idle = phase === 'offline' ? 0.02 : phase === 'dormant' ? 0.05 : 0.12
    const breathe =
      (Math.sin(state.clock.elapsedTime * 0.9) * 0.5 + 0.5) * idle
    const want = Math.max(level, breathe)
    drive.level += (want - drive.level) * Math.min(1, dt * 9)

    // Slow drift on the camera keeps handheld-ish life in the shot — and it is
    // the one motion here that moves the whole picture rather than something
    // inside it, which is exactly what someone who asks for reduced motion is
    // asking to be spared. The reactor itself keeps breathing: it is the
    // interface's pulse, and a still one reads as a crash.
    const t = state.clock.elapsedTime
    const drift = reducedMotion?.matches ? 0 : 1
    state.camera.position.x = Math.sin(t * 0.13) * 0.35 * drift
    state.camera.position.y = Math.cos(t * 0.17) * 0.22 * drift
    state.camera.lookAt(0, 0, 0)
  })

  // Nothing in here is lit: both the core and the dust are raw ShaderMaterials,
  // which do not read the light list. The scene therefore has no lights at all.
  //
  // The tilted gyro rings that used to sit here are gone. Steeply tilted arcs
  // crossing in front of a complete circle do not read as depth — they read as
  // scratches on the lens, and as broken circles in a design whose whole
  // subject is one unbroken one.
  return (
    <>
      <Core drive={drive} />
      <Particles drive={drive} />
      <Orbits />
    </>
  )
}

/**
 * The post chain, in order.
 *
 * A list rather than markup because two of the four are left out on a phone,
 * and EffectComposer takes elements — a `false` among its children is a type
 * error, and more to the point a hole in a pipeline whose order is the whole
 * contract.
 *
 * Bloom is what turns additive lines into "hologram", and the vignette is
 * what keeps the frame from floating; those two shape the picture and stay
 * everywhere. The other two work at the scale of a single pixel — a fringe of
 * about a thousandth of the frame and a film grain at three percent — so on a
 * phone, whose pixels are a third the size and whose fill rate is the thing in
 * shortest supply, they are two full-frame passes spent under the threshold of
 * what the screen can resolve.
 */
const effects = [
  <Bloom
    key="bloom"
    intensity={1.15}
    // A higher threshold keeps the mid-tones intact so the orb doesn't
    // flatten into a solid white disc.
    luminanceThreshold={0.22}
    luminanceSmoothing={0.85}
    mipmapBlur
    radius={0.72}
  />,
  ...(onPhone
    ? []
    : [
        <ChromaticAberration
          key="aberration"
          offset={new THREE.Vector2(0.0009, 0.0012)}
          radialModulation={false}
          modulationOffset={0}
        />,
        <Noise key="grain" opacity={0.035} blendFunction={BlendFunction.OVERLAY} />,
      ]),
  <Vignette key="vignette" eskil={false} offset={0.22} darkness={0.95} />,
]

export function Scene() {
  return (
    <Canvas
      className="scene"
      camera={{ position: [0, 0, 6.2], fov: 45 }}
      /*
        antialias: false because the multisampled back buffer it allocates is
        never drawn into. EffectComposer renders the scene to its own targets
        and blits the result, so the canvas MSAA buffer is memory and
        bandwidth spent on a surface nothing ever touches — and the composer
        is already told multisampling={0} below, for the reason given there.
      */
      gl={{ antialias: false, alpha: true }}
      dpr={[1, DPR_MAX]}
      /* Advanced by Pace, so the cost follows the moment. */
      frameloop="never"
    >
      <Pace />
      <Rig />
      {/*
        multisampling={0} on purpose. The default is 8, which allocates a
        half-float MSAA target — at dpr 2 that is a 3200x1800 buffer — and there
        is not one polygon edge in this scene for it to smooth: everything is
        additive blobs, point sprites and lines, all of which are already
        soft-edged by their own falloff and then blurred again by bloom.

        Tone mapping is also deliberate, if less obviously so. EffectComposer
        forces gl.toneMapping to NoToneMapping while it is mounted (there is no
        prop for it), so the additive output clips instead of rolling off. That
        hard clip to white is the neon look this piece wants — the sweep and the
        rim are meant to blow out. If you ever want the filmic roll-off back,
        add a <ToneMapping mode={ToneMappingMode.ACES_FILMIC} /> effect at the
        end of this chain rather than touching the renderer.
      */}
      <EffectComposer multisampling={0}>{effects}</EffectComposer>
    </Canvas>
  )
}
