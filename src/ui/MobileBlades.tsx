import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { mediaUrl } from '../lib/mediaUrl'
import { accentFor, useStore, type Blade } from '../store'
import { ViewerIcon } from './ViewerIcon'
import { viewerLabels as t } from './viewerLabels'

export function MobileBlades({ blades, active, expanded, onSelect, onExpand, onClose, children }: {
  blades: Blade[]; active: Blade; expanded: boolean
  onSelect: (id: string) => void; onExpand: () => void; onClose: () => void; children: ReactNode
}) {
  const accent = useStore((state) => accentFor(state.phase, state.ui))
  const index = blades.findIndex((blade) => blade.id === active.id)
  const shell = useRef<HTMLElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  useEffect(() => {
    rail.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [active.id])
  useEffect(() => {
    if (!expanded) return
    const previous = document.activeElement as HTMLElement | null
    shell.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [expanded])

  return <section ref={shell} className={`bl bl-front mobile-blades${expanded ? ' mb-full' : ''}`}
    style={{ '--accent': accent } as CSSProperties}
    role={expanded ? 'dialog' : 'region'} aria-modal={expanded || undefined} aria-label={t.viewer}
    onKeyDown={(event) => {
      if (!expanded || event.key !== 'Tab') return
      const buttons = shell.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"], iframe')
      if (!buttons?.length) return
      const first = buttons[0]
      const last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }}>
    <span className="pk pk-tl" aria-hidden="true" /><span className="pk pk-tr" aria-hidden="true" />
    <span className="pk pk-bl" aria-hidden="true" /><span className="pk pk-br" aria-hidden="true" />
    <header className="bl-head mb-header">
      <div className="mb-heading"><span className="mb-eyebrow"><span />J.A.R.V.I.S. <span className="mb-separator">/</span> {t.viewer}</span><h2 className="bl-title" title={active.title}>{active.title}</h2></div>
      <button className="iv-button" aria-label={expanded ? t.collapse : t.expand} onClick={onExpand}><ViewerIcon name={expanded ? 'collapse' : 'expand'} /></button>
      <button className="iv-button mb-close" aria-label={t.close} onClick={onClose}><ViewerIcon name="close" /></button>
    </header>
    <div className={`mb-content mb-content-${active.kind}`} key={active.id}>{children}</div>
    {blades.length > 1 && <footer className="mb-footer">
      <div className="mb-history" ref={rail} role="group" aria-label={t.history}>
        {blades.map((blade, i) => {
          const preview = blade.kind === 'image' ? blade.url : blade.kind === 'gallery' ? blade.images?.[0] : undefined
          return <button key={blade.id} className="mb-history-item" aria-current={blade.id === active.id ? 'true' : undefined} aria-label={`${i + 1}. ${blade.title}`} onClick={() => onSelect(blade.id)}>
            <span className="mb-history-preview">{preview ? <img src={mediaUrl(preview, BRIDGE_HTTP_URL)} alt="" loading="lazy" /> : <ViewerIcon name="image" />}</span>
            <span className="mb-history-number">{String(i + 1).padStart(2, '0')}</span>
          </button>
        })}
      </div>
      <nav className="mb-navigation" aria-label={t.history}>
        <button className="iv-button mb-nav-button" disabled={index <= 0} onClick={() => onSelect(blades[index - 1].id)}><ViewerIcon name="left" /><span>{t.previous}</span></button>
        <output aria-live="polite" aria-atomic="true">{index + 1}<span> / {blades.length}</span></output>
        <button className="iv-button mb-nav-button" disabled={index >= blades.length - 1} onClick={() => onSelect(blades[index + 1].id)}><span>{t.next}</span><ViewerIcon name="right" /></button>
      </nav>
    </footer>}
  </section>
}
