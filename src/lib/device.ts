import { agentTurn, type ChatMessage, type ChatChunk } from '../../shared/agent-loop.mjs'
import { androidTools } from '../../shared/android-agent.mjs'
import { remoteChat } from '../../shared/remote-chat.mjs'
import { pcTools } from '../../shared/pc-agent.mjs'
import { accessToken, bridgeFetch } from './bridgeAuth'
import { BRIDGE_HTTP_URL } from '../config'
import { boundedChat, LOCAL_CONTEXT_BYTES } from '../../shared/context-window.mjs'
import { JarvisFiles, JarvisLlm, JarvisModels } from './android'
import { readDeviceSettings } from './deviceSettings'
import { CapacitorHttp } from '@capacitor/core'
import type { AskHandlers } from './anthropic'
import { useStore } from '../store'

let active: AbortController | null = null
let settled: Promise<unknown> = Promise.resolve()
const history: Array<{ user: string; jarvis: string; messages: ChatMessage[] }> = []

async function* nativeChat(messages: ChatMessage[], tools: unknown[], signal?: AbortSignal): AsyncGenerator<ChatChunk> {
  signal?.throwIfAborted()
  const id = crypto.randomUUID()
  const queue: ChatChunk[] = []
  let done = false
  let failure: unknown
  let wake = () => {}
  const listener = await JarvisLlm.addListener('token', (event) => {
    if (event.id !== id) return
    queue.push({ message: event.message }); wake()
  })
  const abort = () => { void JarvisLlm.cancel(); wake() }
  signal?.addEventListener('abort', abort, { once: true })
  const generation = JarvisLlm.generate({ id, messages, tools }).catch((e) => { failure = e }).finally(() => { done = true; wake() })
  try {
    while (!done || queue.length) {
      signal?.throwIfAborted()
      if (queue.length) yield queue.shift()!
      else await new Promise<void>((resolve) => { wake = resolve })
    }
    if (failure) throw failure
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!done) await JarvisLlm.cancel()
    await generation
    await listener.remove()
  }
}

const chat = (messages: ChatMessage[], tools: unknown[], signal?: AbortSignal) =>
  boundedChat(nativeChat, messages, tools, signal)


export async function warm(): Promise<void> {
  const state = await JarvisLlm.status()
  if (state.loaded) return
  const model = await JarvisModels.status()
  if (!model.path) throw new Error('Ouvrez Réglages Android pour importer ou télécharger Gemma.')
  await JarvisLlm.load({ modelPath: model.path, backend: readDeviceSettings().backend })
}

export async function ask(prompt: string, handlers: AskHandlers, files: string[] = [], inference: 'device' | 'pc' = 'device'): Promise<{ text: string; tools: string[] }> {
  cancel()
  await settled.catch(() => {})
  const controller = new AbortController()
  active = controller
  const operation = (async () => {
    if (inference === 'device') await warm()
    controller.signal.throwIfAborted()
    const pcUrl = BRIDGE_HTTP_URL
    const phone = await androidTools(JarvisFiles, {
      show: (blade) => {
        // The viewer loads images through the PC bridge.
        if (blade.kind === 'image' && inference !== 'pc') throw new Error('Connect the PC to show an image')
        useStore.getState().pushBlade(blade)
      },
      // Native HTTP: the WebView's own fetch is bound by CORS. The web tools
      // follow redirects themselves so that every hop is vetted.
      http: (request) => CapacitorHttp.request({ ...request, responseType: 'text', disableRedirects: true, connectTimeout: 10_000, readTimeout: 20_000 }),
      // On-device Gemma has a 4,096-token window; a PC model reads far more.
      context: inference === 'pc' ? undefined : LOCAL_CONTEXT_BYTES,
    })
    // The endpoint executes the PC's existing file tools under its own policy.
    // Keep both sets in the same loop, so the LLM chooses the device and steps.
    const pcToken = accessToken()
    let pc: { tools: typeof phone.tools; system: string } = { tools: [], system: '' }
    if (inference === 'pc') {
      try { pc = await pcTools(bridgeFetch, pcUrl, JarvisFiles, () => pcToken, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])) }
      catch (err) {
        if (controller.signal.aborted || readDeviceSettings().mode !== 'auto') throw err
        pc.system = 'Les outils du PC sont actuellement injoignables ; seuls les outils Android sont disponibles pour ce tour.'
      }
    }
    const tools = [...phone.tools, ...pc.tools]
    const system = [phone.system, pc.system].filter(Boolean).join('\n\n')
    const used: string[] = []
    useStore.getState().setBrain(inference === 'device' ? { kind: 'local', model: 'Gemma embarqué', reason: 'Android' } : { kind: 'claude', model: 'PC · outils Android et PC', reason: 'Android' })
    let source = inference
    async function* modelChat(messages: ChatMessage[], specs: unknown[], signal?: AbortSignal): AsyncGenerator<ChatChunk> {
      if (source === 'pc') {
        let emitted = false
        try {
          for await (const chunk of remoteChat(bridgeFetch, pcUrl, messages, specs, signal)) { emitted = true; yield chunk }
          return
        } catch (err) {
          if (emitted || signal?.aborted || readDeviceSettings().mode !== 'auto') throw err
          // Continue the same loop with completed tool results, never replay a turn.
          source = 'device'
          await warm()
          signal?.throwIfAborted()
          useStore.getState().setBrain({ kind: 'local', model: 'Gemma embarqué', reason: 'Android' })
        }
      }
      // A PC that went offline cannot execute its tools. Keep completed results
      // in the conversation, but leave Gemma its original, small Android schema.
      const phoneNames = new Set(phone.tools.map((tool) => tool.name))
      yield* chat(messages.map((message) => message.role === 'system'
        ? { ...message, content: `${phone.system}${inference === 'pc' ? '\nLe PC est injoignable ; seuls les outils Android sont disponibles. Ne répète pas les actions déjà terminées.' : ''}` }
        : message), specs.filter((spec) => phoneNames.has((spec as { function: { name: string } }).function.name)), signal)
    }
    const question = files.length ? `${prompt}\nPièces jointes (chemins, données) : ${JSON.stringify(files)}` : prompt
    let turnMessages: ChatMessage[] = []
    const text = await agentTurn(question, {
      chat: modelChat,
      system, tools, history: history.slice(-6), signal: controller.signal,
      maxSteps: inference === 'pc' ? 12 : 6,
      onMessages: (messages) => { turnMessages = messages },
      onText: handlers.onText, onTool: (name) => { used.push(name); handlers.onTool(name) },
    })
    history.push({ user: question, jarvis: text, messages: turnMessages })
    if (history.length > 6) history.splice(0, history.length - 6)
    return { text, tools: used }
  })()
  settled = operation
  try { return await operation }
  finally { if (active === controller) active = null }
}

export function cancel(): void { active?.abort(); if (active) void JarvisLlm.cancel() }
