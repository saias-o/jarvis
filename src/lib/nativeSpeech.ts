/** Short utterances avoid long-running system TTS stalls without pausing audio.
 * Android implements speechSynthesis.pause() as cancel(), so a pause/resume
 * keepalive truncates the sentence instead of keeping it alive. */
export function nativeSpeechChunks(text: string): string[] {
  const chunks: string[] = []
  let chunk = ''
  let words = 0
  for (const word of text.trim().split(/\s+/u).filter(Boolean)) {
    if (chunk && (chunk.length + word.length + 1 > 140 || words >= 20)) {
      chunks.push(chunk)
      chunk = ''
      words = 0
    }
    chunk += (chunk ? ' ' : '') + word
    words++
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

type Options = {
  synth: Pick<SpeechSynthesis, 'speak' | 'cancel' | 'resume'>
  voice: () => SpeechSynthesisVoice | null
  /** A function when the language can change between utterances. */
  lang: string | (() => string)
  createUtterance?: (text: string) => SpeechSynthesisUtterance
  onStart?: (utterance: SpeechSynthesisUtterance) => void
  onQueue?: (utterance: SpeechSynthesisUtterance) => void
  onError?: (code: string, utterance: SpeechSynthesisUtterance) => void
}

export function createNativeSpeech(options: Options) {
  const { synth } = options
  // Hold the utterance strongly until its terminal event. Some browser speech
  // engines do not retain the JS wrapper and its callbacks themselves.
  let active: SpeechSynthesisUtterance | null = null
  let abortCurrent: (() => void) | null = null
  let stopped = false

  const play = (text: string) => new Promise<boolean>((resolve) => {
    let done = false
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const detach = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = null
      if (active) active.onstart = active.onend = active.onerror = null
      active = null
    }
    const finish = (completed: boolean) => {
      if (done) return
      done = true
      detach()
      abortCurrent = null
      resolve(completed)
    }
    abortCurrent = () => finish(false)

    const attempt = (retry: boolean) => {
      if (stopped) { finish(false); return }
      const utterance = options.createUtterance?.(text) ?? new SpeechSynthesisUtterance(text)
      active = utterance
      const voice = options.voice()
      if (voice) utterance.voice = voice
      utterance.lang = voice?.lang ?? (typeof options.lang === 'function' ? options.lang() : options.lang)
      utterance.rate = 0.92
      utterance.pitch = 0.95
      let started = false
      utterance.onstart = () => {
        if (active !== utterance || done) return
        started = true
        if (watchdog) clearTimeout(watchdog)
        watchdog = null
        options.onStart?.(utterance)
      }
      utterance.onend = () => {
        if (active === utterance) finish(true)
      }
      utterance.onerror = (event) => {
        if (active !== utterance || done) return
        options.onError?.(String(event.error ?? 'unknown'), utterance)
        finish(false)
      }
      watchdog = setTimeout(() => {
        if (done || started || active !== utterance) return
        // Slow mobile voices need time to initialise. Detach the abandoned
        // attempt before cancelling: its late error must not end the retry.
        detach()
        try { synth.cancel() } catch { /* already stopped */ }
        if (retry) {
          options.onError?.('no-start', utterance)
          finish(false)
        } else attempt(true)
      }, 3000)
      options.onQueue?.(utterance)
      try {
        synth.resume()
        synth.speak(utterance)
      } catch {
        options.onError?.('synthesis-failed', utterance)
        finish(false)
      }
    }
    attempt(false)
  })

  return {
    async speak(text: string): Promise<boolean> {
      for (const chunk of nativeSpeechChunks(text)) {
        if (stopped || !(await play(chunk))) return false
      }
      return !stopped
    },
    cancel() {
      stopped = true
      if (!active) return
      // Settle even if the browser omits onend/onerror after cancel().
      abortCurrent?.()
      synth.cancel()
      synth.resume()
    },
  }
}
