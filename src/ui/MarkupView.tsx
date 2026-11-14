import { useMemo, useState } from 'react'
import { sanitisePanelHtml } from './sanitise'
import { ImageViewer } from './ImageViewer'
import { ViewerIcon } from './ViewerIcon'
import { viewerLabels as t } from './viewerLabels'

/** Images embedded in a report open in the same accessible viewer. */
export function MarkupView({ html, title }: { html: string; title: string }) {
  const [selected, setSelected] = useState<number | null>(null)
  const content = useMemo(() => {
    const doc = new DOMParser().parseFromString(sanitisePanelHtml(html), 'text/html')
    const images = [...doc.querySelectorAll('img[src]')]
    images.forEach((image, i) => {
      image.setAttribute('tabindex', '0')
      image.setAttribute('role', 'button')
      image.setAttribute('aria-label', `${t.viewer} — ${t.image} ${i + 1}`)
      image.setAttribute('data-viewer-index', String(i))
    })
    return { html: doc.body.innerHTML, sources: images.map((image) => image.getAttribute('src')!) }
  }, [html])

  const open = (target: EventTarget) => {
    if (!(target instanceof HTMLImageElement)) return
    const index = target.dataset.viewerIndex
    if (index !== undefined) setSelected(Number(index))
  }
  if (selected !== null) return <div className="markup-image-viewer">
    <button className="iv-button markup-view-back" onClick={() => setSelected(null)}><ViewerIcon name="left" />{t.back}</button>
    <ImageViewer sources={content.sources} title={title} initialIndex={selected} />
  </div>
  return <div className="bl-markup p-body" dangerouslySetInnerHTML={{ __html: content.html }}
    onClick={(event) => open(event.target)}
    onKeyDown={(event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLImageElement) {
        event.preventDefault()
        event.stopPropagation()
        open(event.target)
      }
    }} />
}
