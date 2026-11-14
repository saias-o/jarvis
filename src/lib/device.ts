import { agentTurn, type ChatMessage, type ChatChunk } from '../../shared/agent-loop.mjs'
import { androidTools } from '../../shared/android-agent.mjs'
import { remoteChat } from '../../shared/remote-chat.mjs'
import { bridgeFetch } from './bridgeAuth'
import { BRIDGE_HTTP_URL } from '../config'
import { boundedChat } from '../../shared/context-window.mjs'
import { JarvisFiles, JarvisLlm, JarvisModels } from './android'
import { readDeviceSettings } from './deviceSettings'
import type { AskHandlers } from './anthropic'
import { useStore } from '../store'

let active: AbortController | null = null
let settled: Promise<unknown> = Promise.resolve()
const history: Array<{ user: string; jarvis: string }> = []

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
    const { tools, system } = await androidTools(JarvisFiles, (title, text) => {
      const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
      useStore.getState().pushBlade({ id: crypto.randomUUID(), kind: 'markup', title: String(title).slice(0, 60), html: `<p>${escape(text).replace(/\n/g, '<br>')}</p>`, size: 'compact', hold: 'turn' })
    })
    const used: string[] = []
    useStore.getState().setBrain(inference === 'device' ? { kind: 'local', model: 'Gemma embarqué', reason: 'Android' } : { kind: 'claude', model: 'PC · outils Android', reason: 'Android' })
    let source = inference
    async function* modelChat(messages: ChatMessage[], specs: unknown[], signal?: AbortSignal): AsyncGenerator<ChatChunk> {
      if (source === 'pc') {
        let emitted = false
        try {
          for await (const chunk of remoteChat(bridgeFetch, BRIDGE_HTTP_URL, messages, specs, signal)) { emitted = true; yield chunk }
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
      yield* chat(messages, specs, signal)
    }
    const question = files.length ? `${prompt}\nPièces jointes (chemins, données) : ${JSON.stringify(files)}` : prompt
    const text = await agentTurn(question, {
      chat: modelChat,
      system, tools, history: history.slice(-6), signal: controller.signal,
      maxSteps: inference === 'pc' ? 12 : 6,
      onText: handlers.onText, onTool: (name) => { used.push(name); handlers.onTool(name) },
    })
    history.push({ user: question, jarvis: text })
    return { text, tools: used }
  })()
  settled = operation
  try { return await operation }
  finally { if (active === controller) active = null }
}

export function cancel(): void { active?.abort(); if (active) void JarvisLlm.cancel() }
