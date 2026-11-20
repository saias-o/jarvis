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
import { useStore, type Blade } from '../store'
import { diagnostics } from './trace'
import { applyUiOp } from './uiOps'
import { capture, type CameraRequest } from './capture'
import type { Trace } from '../../shared/trace.mjs'

let active: AbortController | null = null
let settled: Promise<unknown> = Promise.resolve()
const history: Array<{ user: string; jarvis: string; messages: ChatMessage[] }> = []

/**
 * Width ceiling for a camera frame leaving the phone.
 *
 * The frame travels to the PC inside the /inference body, which also carries
 * the conversation and every schema inside 256 kB. A full-size still is 150 to
 * 250 kB of base64 on its own, so the phone asks the camera for a smaller one
 * rather than sending something the budget then has to throw away. The PC's own
 * socket has no such limit and keeps full-size frames.
 */
const PHONE_FRAME_WIDTH = 1024

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
    /**
     * The page may only load media from the PC bridge, its own data and the
     * video players its policy names. Without the PC, a picture from the web is
     * fetched natively; an article, a video file or a PDF outside Drive goes
     * through the bridge and is refused with the reason, never shown blank.
     */
    const withoutPc = async <T extends { kind: string; url?: string; images?: string[] }>(blade: T): Promise<T> => {
      const signal = controller.signal
      const picture = (url = '') => {
        if (!/^https?:\/\//i.test(url)) throw new Error('Connect the PC to show a file stored on the PC')
        return webImage(http, url, { signal })
      }
      if (blade.kind === 'image') return { ...blade, url: await picture(blade.url) }
      if (blade.kind === 'gallery') return { ...blade, images: await Promise.all((blade.images ?? []).map((url) => picture(url))) }
      if (blade.kind === 'article' || blade.kind === 'video' || (blade.kind === 'pdf' && !/^https:\/\/drive\.google\.com\//i.test(blade.url ?? ''))) {
        throw new Error(`Connect the PC to open this ${blade.kind}: the phone loads it through the PC bridge. show and web_fetch work without it.`)
      }
      return blade
    }
    const phone = await androidTools(JarvisFiles, {
      // The same interface as on the PC, redressed by the same ui_* tools.
      ui: applyUiOp,
      // The camera, from the WebView that owns it — but only to a model that
      // can see what comes back. On-device Gemma reads text only, so with it
      // selected the phone hands over no capture and look/watch are not
      // offered; the catalogue leaves them out of every local tool group too,
      // so a fallback to Gemma mid-turn withdraws them as well.
      capture: pcUrl && inference === 'pc'
        ? ((request: CameraRequest) => capture(request, PHONE_FRAME_WIDTH))
        : undefined,
      show: async (blade) => {
        if (!hostOnline) blade = await withoutPc(blade)
        useStore.getState().pushBlade({ ...blade, trace: context } as Blade)
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
