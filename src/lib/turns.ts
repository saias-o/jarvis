/**
 * The conversation, as a state machine.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 *
 * Everything this touches outside itself — the store, the model, the speech
 * engine, the sounds — is handed in, so a turn's whole life, including what is
 * left behind when the app goes away, can be exercised without a browser.
 */

import type { Phase } from '../store'
import { noteSpoken } from './language'
import type { VoiceMode } from './voice'

export type Speaker = {
  push(delta: string): void
  say(text: string): void
  end(): Promise<void>
  cancel(): void
  level(): number
}

/** The part of the store a turn drives. */
export type TurnState = {
  phase: Phase
  setPhase(phase: Phase): void
  setCaption(text: string): void
  setActiveTool(name: string | null): void
  setError(message: string | null): void
  clearBlades(): void
  pushTurn(turn: { id: string; role: 'user' | 'jarvis'; text: string }): void
  appendToLastTurn(delta: string): void
}

type Message = { role: 'user' | 'assistant'; content: string }

export type TurnDeps = {
  state(): TurnState
  ask(
    said: string,
    history: Message[],
    handlers: { onText(delta: string): void; onTool(name: string): void },
    files: string[],
  ): Promise<{ text: string }>
  /** Stops the answer in flight and settles its `ask`. */
  cancel(): void
  speaker(): Speaker
  /** Files handed over since the last question; they go with this one. */
  takeFiles(): Array<{ name: string; path?: string }>
  /** The direct path threads history itself; the bridge keeps it in its session. */
  keepHistory: boolean
  sounds: { play(cue: 'listen' | 'wake' | 'tool' | 'done' | 'error'): void; duck(on: boolean): void }
  music: { working(on: boolean): void; duck(on: boolean): void }
  forTool(name: string): string
  attention(): string
  /** The text without his name used as a vocative; empty when nothing is left. */
  withoutVocative(text: string): string
  newId(): string
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
}

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
export const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
export const FOLLOW_UP_MS = 11000

const BUSY: Phase[] = ['thinking', 'tooling', 'speaking']
const ASLEEP: Phase[] = ['offline', 'boot', 'dormant']

export function createTurns(deps: TurnDeps) {
  const { state, music, sounds } = deps
  const timers = deps.timers ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  let history: Message[] = []
  let speaker: Speaker | null = null
  let idle: unknown = null
  let disposed = false

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  let turn = 0

  const clearIdle = () => {
    if (idle !== null) timers.clear(idle)
    idle = null
  }

  const silence = () => {
    speaker?.cancel()
    speaker = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn++
    const s = state()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sounds.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    if (disposed) return
    clearIdle()
    const s = state()
    s.setCaption('')
    s.setPhase('listening')
    sounds.play('listen')
    idle = timers.set(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    if (disposed) return
    const mine = ++turn
    const stale = () => mine !== turn

    // Their words, not the answer's, decide what language this conversation is
    // being held in: it is what the microphone listens in next and what the
    // canned lines are drawn from. The answer carries itself — the voice is
    // chosen per sentence, from the sentence.
    noteSpoken(said)

    clearIdle()
    const s = state()
    // Last turn's blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearBlades()
    s.setCaption('')
    // Files handed over since the last question go with this one, whether it
    // was typed or spoken. The transcript shows their names; the bridge tells
    // the agent where they are.
    const files = deps.takeFiles()
    const named = files.map((f) => f.name).join(', ')
    s.pushTurn({
      id: deps.newId(),
      role: 'user',
      text: named ? (said ? `${said} [${named}]` : `[${named}]`) : said,
    })
    s.setPhase('thinking')

    const spk = deps.speaker()
    speaker = spk
    sounds.duck(true)
    music.duck(true)

    const turnId = deps.newId()
    let started = false
    let filled = false

    try {
      const { text } = await deps.ask(said, history, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            state().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            state().setActiveTool(null)
            music.working(false)
            state().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          state().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) state().setPhase('tooling')
          state().setActiveTool(name)
          sounds.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(deps.forTool(name))
          }
        },
      }, files.map((f) => f.path!))

      if (stale()) return

      if (deps.keepHistory) {
        history.push({ role: 'user', content: said })
        history.push({ role: 'assistant', content: text || '…' })
        if (history.length > 16) history = history.slice(-16)
      }

      await spk.end()
      if (stale()) return
      sounds.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sounds.play('error')
      state().setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      if (!stale()) {
        speaker = null
        sounds.duck(false)
        music.duck(false)
        state().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    if (disposed) return 'deaf'
    switch (state().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string) => {
    const phase = state().phase
    if (disposed || phase === 'offline' || phase === 'boot') return

    state().setError(null)
    sounds.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing)
      return
    }

    state().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited: the microphone is already
    // open and the echo filter knows his voice, so the user can talk straight
    // over the greeting instead of waiting it out.
    const greeting = deps.speaker()
    speaker = greeting
    greeting.say(deps.attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the event machine: he
   * stops, immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = state().phase
    if (disposed || ASLEEP.includes(phase)) return

    silence()
    if (BUSY.includes(phase)) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn++
      deps.cancel()
      state().setActiveTool(null)
      music.working(false)
      sounds.duck(false)
      music.duck(false)
    }
    state().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = state().phase
    if (disposed || ASLEEP.includes(phase)) return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    const said = deps.withoutVocative(text)
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    void respond(said)
  }

  /** One press, read against the phase: wake, cut in, or stand down. */
  const talk = () => {
    const phase = state().phase
    if (phase === 'offline' || phase === 'boot') return
    if (BUSY.includes(phase)) {
      onSpeechStart()
      listen(AWAIT_SPEECH_MS)
    } else if (phase === 'dormant') {
      onWake('')
    } else {
      goDormant()
    }
  }

  return {
    mode,
    onWake,
    onSpeechStart,
    onUtterance,
    onPartial: (text: string) => state().setCaption(text),
    onError: (message: string) => state().setError(message),
    talk,
    /**
     * A typed line is an utterance that skipped the microphone. It takes the
     * same road from here: whatever he was doing stops, and this becomes the
     * turn. From standby it also stands in for the wake word.
     */
    sendText(said: string) {
      const phase = state().phase
      if (phase === 'offline' || phase === 'boot') return
      state().setError(null)
      // Silences a greeting or an answer in flight and abandons its turn; a
      // no-op from standby, where there is nothing to cut off.
      onSpeechStart()
      void respond(said)
    },
    goDormant,
    /** Space and the talk button mid-answer: cut in and wait for the new question. */
    interrupt() {
      onSpeechStart()
      listen(AWAIT_SPEECH_MS)
    },
    /** A fixed line spoken over whatever was playing (voice audition, audio test). */
    speak(line: string) {
      silence()
      const spk = deps.speaker()
      speaker = spk
      spk.say(line)
      return spk.end()
    },
    /** JARVIS's own loudness while he speaks, for the reactor; null otherwise. */
    level: () => (state().phase === 'speaking' && speaker ? speaker.level() : null),
    /**
     * The app is going away: no timer fires, nothing keeps speaking, and the
     * answer in flight can no longer touch the store.
     */
    dispose() {
      if (disposed) return
      clearIdle()
      silence()
      if (BUSY.includes(state().phase)) deps.cancel()
      turn++
      disposed = true
    },
  }
}

export type Turns = ReturnType<typeof createTurns>
