import { isAndroid, JarvisFiles } from './android'
import { useStore } from '../store'

/**
 * Files shared to JARVIS from other Android apps become attachments of the
 * next question. Polled while the app is visible; returns the stop.
 */
export function receiveShares(): () => void {
  if (!isAndroid) return () => {}
  let stopped = false
  let reading = false
  const receive = async () => {
    if (reading || stopped) return
    reading = true
    try {
      const shared = await JarvisFiles.takeShares()
      if (!stopped) for (const file of shared.files) useStore.getState().addAttachment({ ...file, id: crypto.randomUUID(), state: 'ready' })
    } catch (err) { console.warn('[jarvis] could not receive shared files', err) }
    finally { reading = false }
  }
  void receive()
  const timer = setInterval(() => { if (!document.hidden) void receive() }, 2000)
  return () => { stopped = true; clearInterval(timer) }
}
