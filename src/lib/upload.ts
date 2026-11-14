import { isAndroid, JarvisFiles } from './android'
import { bridgeFetch } from './bridgeAuth'
import { BRIDGE_HTTP_URL } from '../config'
import { useStore, type Attachment } from '../store'

/**
 * Handing JARVIS a file.
 *
 * A file dropped on the page, pasted into it or picked from the phone goes to
 * the bridge, which stores it in its inbox and answers with where. It then
 * waits here, as an attachment, for the next thing said — typed or spoken —
 * and travels with that question as a path. The bytes are never put in the
 * conversation: the agent reads the file from disk with its own tools, so a
 * two-hundred-page PDF costs nothing until he is asked about it.
 */

let seq = 0

async function upload(file: File): Promise<{ path: string; name: string; size: number }> {
  if (isAndroid) {
    if (file.size > 16 * 1024 * 1024) throw new Error('Utilisez Partager vers JARVIS pour les fichiers de plus de 16 Mo.')
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
    return JarvisFiles.saveAttachment({ name: file.name, data: btoa(binary) })
  }
  const res = await bridgeFetch(`${BRIDGE_HTTP_URL}/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) throw new Error(res.status === 413 ? 'too large' : `refused (${res.status})`)
  return res.json()
}

/** Upload each file and track it in the store; resolves when all have settled. */
export async function handFiles(files: Iterable<File>): Promise<void> {
  const s = useStore.getState()
  await Promise.all(
    [...files].map(async (file) => {
      const id = `f${++seq}`
      s.addAttachment({ id, name: file.name || 'file', size: file.size, state: 'sending' })
      try {
        const saved = await upload(file)
        useStore.getState().updateAttachment(id, { state: 'ready', path: saved.path, name: saved.name })
      } catch (err) {
        console.error('[jarvis] upload failed:', err)
        useStore.getState().updateAttachment(id, { state: 'failed' })
      }
    }),
  )
}

/**
 * The files that go with the question being asked now. Takes the ones that
 * have arrived and clears away the failures; an upload still in flight stays,
 * and goes with the question after.
 */
export function takeAttachments(): Attachment[] {
  const s = useStore.getState()
  const ready = s.attachments.filter((a) => a.state === 'ready' && a.path)
  for (const a of s.attachments) if (a.state !== 'sending') s.removeAttachment(a.id)
  return ready
}

/** True when a drag is carrying files, as opposed to text or a link. */
export const carriesFiles = (e: DragEvent): boolean =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files')
