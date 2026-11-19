import { agentTurn, type ChatMessage, type ChatChunk } from '../../shared/agent-loop.mjs'
import { androidCatalogue, androidChat, androidTools, type AndroidRoute } from '../../shared/android-agent.mjs'
import { remoteChat } from '../../shared/remote-chat.mjs'
import { pcTools } from '../../shared/pc-agent.mjs'
import { accessToken, bridgeFetch } from './bridgeAuth'
import { LOCAL_CONTEXT_BYTES } from '../../shared/context-window.mjs'
import { JarvisFiles, JarvisLlm, JarvisModels } from './android'
import { readDeviceSettings } from './deviceSettings'
import { CapacitorHttp } from '@capacitor/core'
import { webImage, type WebHttp } from '../../shared/web-tools.mjs'
import { appendExchange } from '../../shared/conversation.mjs'
import type { AskHandlers } from './anthropic'
import { useStore } from '../store'
import { diagnostics } from './trace'
import { applyUiOp } from './uiOps'
import type { Trace } from '../../shared/trace.mjs'

let active: AbortController | null = null
let settled: Promise<unknown> = Promise.resolve()
const history: Array<{ user: string; jarvis: string; messages: ChatMessage[] }> = []

async function* nativeChat(messages: ChatMessage[], tools: unknown[], signal?: AbortSignal, trace?: Trace): AsyncGenerator<ChatChunk> {
  signal?.throwIfAborted()
  await trace?.('model.input', { provider: 'android', messages, tools })
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


export async function warm(): Promise<void> {
  const state = await JarvisLlm.status()
  if (state.loaded) return
  const model = await JarvisModels.status()
  if (!model.path) throw new Error('Ouvrez Réglages Android pour importer ou télécharger Gemma.')
  await JarvisLlm.load({ modelPath: model.path, backend: readDeviceSettings().backend })
}

export async function ask(prompt: string, handlers: AskHandlers, files: string[], { inference, pcUrl }: AndroidRoute): Promise<{ text: string; tools: string[] }> {
  cancel()
  await settled.catch(() => {})
  const controller = new AbortController()
  active = controller
  const context = { conversationId: diagnosticsId, turnId: crypto.randomUUID() }
  const logger = diagnostics.child(context)
  const trace = (event: string, data?: Record<string, unknown>) => logger.record(event, data)
  const operation = (async () => {
    await trace('turn.start', { text: prompt, files, history, inference })
    if (inference === 'device') await warm()
    controller.signal.throwIfAborted()
    let hostOnline = Boolean(pcUrl)
    // The model and the devices are chosen apart: whichever model thinks, PC
    // tools go to the PC that serves them and phone tools stay on the phone.
    const onPhone = () => model.source() === 'device'
    const fetchPc = (input: string, init?: RequestInit) => bridgeFetch(input, init, pcUrl!)
    const discover = async () => {
      try {
        const found = await pcTools(fetchPc, pcUrl!, JarvisFiles, () => accessToken(pcUrl!),
          AbortSignal.any([controller.signal, AbortSignal.timeout(3500)]), context, onPhone)
        hostOnline = true
        return found
      } catch (err) { hostOnline = false; throw err }
    }
    let pc: Awaited<ReturnType<typeof pcTools>> = { tools: [], system: '' }
    if (pcUrl) {
      try { pc = await discover() }
      catch (err) {
        if (controller.signal.aborted || readDeviceSettings().mode === 'pc') throw err
      }
    }
    // Native HTTP: the WebView's own fetch is bound by CORS. The web tools
    // follow redirects themselves so that every hop is vetted.
    const http: WebHttp = ({ binary, ...request }) => CapacitorHttp.request({
      ...request, responseType: binary ? 'blob' : 'text', disableRedirects: true, connectTimeout: 10_000, readTimeout: 20_000,
    })
    const phone = await androidTools(JarvisFiles, {
      // The same interface as on the PC, redressed by the same ui_* tools.
      ui: applyUiOp,
      show: async (blade) => {
        // The page may only load images from the PC bridge or from its own
        // data. Without the PC, a picture from the web is fetched natively; a
        // file stored on the PC stays out of reach.
        if (blade.kind === 'image' && !hostOnline) {
          if (!/^https?:\/\//i.test(blade.url ?? '')) throw new Error('Connect the PC to show a file stored on the PC')
          blade = { ...blade, url: await webImage(http, blade.url!, { signal: controller.signal }) }
        }
        useStore.getState().pushBlade({ ...blade, trace: context })
      },
      http,
      // On-device Gemma has a 4,096-token window; a PC model reads far more.
      context: LOCAL_CONTEXT_BYTES - new TextEncoder().encode(pc.system).length - (pc.tools.length ? 400 : 0),
      smallContext: onPhone,
    })
    const catalogue = androidCatalogue(phone, pc)
    const { tools, system } = catalogue
    const used: string[] = []
    const model = androidChat({
      inference: pcUrl ? inference : 'device', catalogue, discover,
      remote: (messages, specs, signal) => remoteChat(fetchPc, pcUrl!, messages, specs, signal, context),
      local: (messages, specs, signal) => nativeChat(messages, specs, signal, trace),
      canFallback: () => readDeviceSettings().mode === 'auto',
      async onFallback(reason) {
        await trace('route.selected', { provider: 'device', reason })
        await warm()
        useStore.getState().setBrain({ kind: 'local', model: 'Gemma embarqué', reason: 'Android' })
      },
    })
    useStore.getState().setBrain(inference === 'device' ? { kind: 'local', model: 'Gemma embarqué', reason: 'Android' } : { kind: 'claude', model: 'PC · outils Android et PC', reason: 'Android' })
    await trace('route.selected', { provider: model.source() })
    const question = files.length ? `${prompt}\nPièces jointes (chemins, données) : ${JSON.stringify(files)}` : prompt
    let turnMessages: ChatMessage[] = []
    const text = await agentTurn(question, {
      chat: model.chat,
      system, tools, history, signal: controller.signal,
      trace,
      maxSteps: inference === 'pc' || pc.tools.length ? 12 : 6,
      onMessages: (messages) => { turnMessages = messages },
      onCheckpoint: (messages) => { appendExchange(history, { id: context.turnId, user: question, jarvis: '', messages }) },
      onText: handlers.onText, onTool: (name) => { used.push(name); handlers.onTool(name) },
    })
    appendExchange(history, { id: context.turnId, user: question, jarvis: text, messages: turnMessages })
    await trace('turn.end', { text, tools: used })
    return { text, tools: used }
  })()
  settled = operation
  try { return await operation }
  catch (error) { await trace(controller.signal.aborted ? 'turn.cancel' : 'turn.error', { error }); throw error }
  finally { if (active === controller) active = null }
}

const diagnosticsId = crypto.randomUUID()

export function cancel(): void { active?.abort(); if (active) void JarvisLlm.cancel() }
