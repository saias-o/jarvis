import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export const isAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
type Listener = { addListener(event: string, callback: (event: any) => void): Promise<PluginListenerHandle> }

export const JarvisLlm = registerPlugin<Listener & {
  load(options: { modelPath: string; backend: string }): Promise<{ loaded: boolean; backend: string }>
  status(): Promise<{ loaded: boolean; modelPath: string; backend: string; busy: boolean }>
  generate(options: { id: string; messages: unknown[]; tools: unknown[] }): Promise<void>
  cancel(): Promise<void>
  unload(): Promise<void>
}>('JarvisLlm')

export const JarvisModels = registerPlugin<Listener & {
  status(): Promise<{ path: string; size: number; downloading: boolean }>
  download(options: { wifiOnly: boolean; url?: string }): Promise<{ path: string }>
  importModel(): Promise<{ path: string }>
  cancel(): Promise<void>
}>('JarvisModels')

export const JarvisSpeech = registerPlugin<Listener & {
  start(options: { lang: string }): Promise<void>
  stop(): Promise<void>
  speak(options: { text: string; lang: string }): Promise<{ completed: boolean }>
  stopSpeaking(): Promise<void>
}>('JarvisSpeech')

export const JarvisFiles = registerPlugin<{
  status(): Promise<{ granted: boolean; root: string; inbox: string }>
  requestAccess(): Promise<void>
  run(options: { name: string; args: Record<string, unknown> }): Promise<{ result: string }>
  readMemory(): Promise<{ text: string }>
  saveAttachment(options: { name: string; data: string }): Promise<{ path: string; name: string; size: number }>
  takeShares(): Promise<{ files: Array<{ path: string; name: string; size: number }> }>
  upload(options: { path: string; url: string; token: string }): Promise<{ path: string }>
}>('JarvisFiles')
