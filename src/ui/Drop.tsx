import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { IS_FRENCH } from '../config'
import { carriesFiles, handFiles } from '../lib/upload'
import * as sfx from '../lib/sfx'

/**
 * The whole window is where a file is handed over.
 *
 * Drop one anywhere, or paste it, and it is on its way to JARVIS: no target to
 * aim at, because nothing else on this screen takes a file. While a drag is
 * over the window a frame says so — the only feedback a drop has before it
 * lands.
 */
export function Drop() {
  const phase = useStore((s) => s.phase)
  const [over, setOver] = useState(false)
  const live = phase !== 'offline' && phase !== 'boot'

  useEffect(() => {
    if (!live) return
    // dragenter and dragleave fire for every element crossed, so depth is
    // counted rather than toggled.
    let depth = 0

    const enter = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      depth++
      setOver(true)
    }
    const move = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      // Without this the browser refuses the drop and opens the file instead.
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const leave = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setOver(false)
    }
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      depth = 0
      setOver(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (!files.length) return
      sfx.play('tool')
      void handFiles(files)
    }
    const paste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      // Pasted text belongs to whatever field has focus; only files are ours.
      if (!files.length) return
      e.preventDefault()
      void handFiles(files)
    }

    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', move)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', move)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [live])

  if (!live || !over) return null
  return (
    <div className="drop-veil" aria-hidden="true">
      <span>{IS_FRENCH ? 'DÉPOSER POUR JARVIS' : 'DROP FOR JARVIS'}</span>
    </div>
  )
}
