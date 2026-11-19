import { useEffect, useRef, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { mediaUrl } from '../lib/mediaUrl'
import { constrainView, FIT_VIEW, fitImage, MAX_IMAGE_ZOOM, zoomImage, type ImageSize, type ImageView } from '../lib/imageViewport'
import { ViewerIcon } from './ViewerIcon'
import { viewerLabels as t } from './viewerLabels'
import { diagnostics } from '../lib/trace'

type Point = { x: number; y: number }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

type TraceContext = { conversationId: string; turnId?: string }
function ImageStage({ src, title, previous, next, traceContext }: { src: string; title: string; previous?: () => void; next?: () => void; traceContext?: TraceContext }) {
  const stage = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<ImageSize>({ width: 0, height: 0 })
  const [viewport, setViewport] = useState<ImageSize>({ width: 0, height: 0 })
  const [view, setView] = useState<ImageView>(FIT_VIEW)
  const current = useRef(view)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const pointers = useRef(new Map<number, Point>())
  const anchor = useRef<{ points: Point[]; view: ImageView } | null>(null)
  const session = useRef({ moved: false, pinched: false })
  const lastTap = useRef<{ time: number; point: Point } | null>(null)
  const fitted = fitImage(natural, viewport)

  const update = (nextView: ImageView) => {
    current.current = nextView
    setView(nextView)
  }
  const reanchor = () => {
    anchor.current = { points: [...pointers.current.values()], view: current.current }
  }
  const local = (point: Point) => {
    const rect = stage.current!.getBoundingClientRect()
    return { x: point.x - rect.left - rect.width / 2, y: point.y - rect.top - rect.height / 2 }
  }
  const zoom = (scale: number, point: Point = { x: 0, y: 0 }) => {
    update(zoomImage(current.current, scale, point, fitted, viewport))
  }

  useEffect(() => {
    const node = stage.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      const nextViewport = { width: entry.contentRect.width, height: entry.contentRect.height }
      setViewport(nextViewport)
      const nextView = constrainView(current.current, fitImage(natural, nextViewport), nextViewport)
      current.current = nextView
      setView(nextView)
      // Rotation changes the coordinate system: end any gesture in progress.
      pointers.current.clear()
      anchor.current = null
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [natural])

  const onDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (status !== 'ready' || event.button !== 0) return
    event.preventDefault()
    if (!pointers.current.size) session.current = { moved: false, pinched: false }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size > 1) {
      session.current.pinched = true
      lastTap.current = null
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic hand pointers have no native browser capture target.
    }
    reanchor()
  }

  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !anchor.current) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const points = [...pointers.current.values()]
    const from = anchor.current
    if (points.length >= 2 && from.points.length >= 2) {
      const scale = Math.min(MAX_IMAGE_ZOOM, Math.max(1, from.view.scale * distance(points[0], points[1]) / Math.max(1, distance(from.points[0], from.points[1]))))
      const start = local(midpoint(from.points[0], from.points[1]))
      const end = local(midpoint(points[0], points[1]))
      const ratio = scale / from.view.scale
      update(constrainView({ scale, x: end.x - (start.x - from.view.x) * ratio, y: end.y - (start.y - from.view.y) * ratio }, fitted, viewport))
    } else if (points.length === 1 && from.points.length === 1) {
      const dx = points[0].x - from.points[0].x
      const dy = points[0].y - from.points[0].y
      if (Math.hypot(dx, dy) > 8) session.current.moved = true
      if (from.view.scale > 1) update(constrainView({ ...from.view, x: from.view.x + dx, y: from.view.y + dy }, fitted, viewport))
    }
  }

  const onUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    const from = anchor.current
    const point = { x: event.clientX, y: event.clientY }
    const cancelled = event.type === 'pointercancel' || event.type === 'lostpointercapture'
    if (!cancelled && pointers.current.size === 1 && !session.current.pinched && from) {
      const dx = point.x - from.points[0].x
      const dy = point.y - from.points[0].y
      if (current.current.scale === 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) next?.()
        else previous?.()
        lastTap.current = null
      } else if (!session.current.moved && Math.hypot(dx, dy) < 8) {
        const now = performance.now()
        const tap = lastTap.current
        if (tap && now - tap.time < 300 && distance(tap.point, point) < 28) {
          zoom(current.current.scale > 1 ? 1 : 2.5, local(point))
          lastTap.current = null
        } else lastTap.current = { time: now, point }
      }
    }
    pointers.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    reanchor()
  }

  let source = mediaUrl(src, BRIDGE_HTTP_URL)
  if (attempt && !/^(data|blob):/i.test(source)) source += `${source.includes('?') ? '&' : '?'}_retry=${attempt}`

  return <>
    <div ref={stage} className={`iv-stage${view.scale > 1 ? ' iv-zoomed' : ''}`} tabIndex={0}
      aria-label={title} aria-roledescription={t.image}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onLostPointerCapture={onUp}
      onKeyDown={(event) => {
        if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(current.current.scale * 1.5) }
        if (event.key === '-') { event.preventDefault(); zoom(current.current.scale / 1.5) }
        if (event.key === '0') { event.preventDefault(); update(FIT_VIEW) }
        if (event.key === 'ArrowLeft' && previous) { event.preventDefault(); previous() }
        if (event.key === 'ArrowRight' && next) { event.preventDefault(); next() }
      }}
      onWheel={(event) => {
        if (event.ctrlKey) return
        zoom(current.current.scale * (event.deltaY > 0 ? 0.85 : 1.15), local({ x: event.clientX, y: event.clientY }))
      }}>
      <img key={attempt} src={source} alt={title} draggable={false} className="iv-image"
        style={{ width: fitted.width, height: fitted.height, visibility: status === 'ready' ? 'visible' : 'hidden', transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        onLoad={(event) => {
          const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }
          setNatural(size); setStatus('ready')
          void diagnostics.child(traceContext ?? {}).record('image.loaded', { url: src, source, title, attempt, ...size })
        }}
        onError={() => {
          setStatus('error')
          void diagnostics.child(traceContext ?? {}).record('image.error', { url: src, source, title, attempt })
        }} />
      {status === 'loading' && <div className="iv-message" role="status"><span className="iv-spinner" />{t.loading}</div>}
      {status === 'error' && <div className="iv-message" role="alert"><ViewerIcon name="image" /><span>{t.failed}</span><button className="iv-retry" onPointerDown={(e) => e.stopPropagation()} onClick={() => { setStatus('loading'); setAttempt((n) => n + 1) }}><ViewerIcon name="retry" />{t.retry}</button></div>}
      {status === 'ready' && <span className="iv-resolution">{natural.width} × {natural.height}</span>}
    </div>
    <div className="iv-toolbar" role="toolbar" aria-label={t.viewer}>
      <div className="iv-zoom-controls">
        <button className="iv-button" aria-label={t.zoomOut} disabled={view.scale <= 1 || status !== 'ready'} onClick={() => zoom(current.current.scale / 1.5)}><ViewerIcon name="minus" /></button>
        <output className="iv-percent" aria-live="polite">{Math.round(view.scale * 100)}%</output>
        <button className="iv-button" aria-label={t.zoomIn} disabled={view.scale >= MAX_IMAGE_ZOOM || status !== 'ready'} onClick={() => zoom(current.current.scale * 1.5)}><ViewerIcon name="plus" /></button>
      </div>
      <button className="iv-button iv-fit" onClick={() => update(FIT_VIEW)} disabled={status !== 'ready'}><ViewerIcon name="fit" /><span>{t.fit}</span></button>
    </div>
    <p className="iv-hint">{view.scale > 1 ? t.zoomHint : t.hint}</p>
  </>
}

export function ImageViewer({ sources, title, previous, next, initialIndex = 0, traceContext }: { sources: string[]; title: string; previous?: () => void; next?: () => void; initialIndex?: number; traceContext?: TraceContext }) {
  const [selected, setSelected] = useState(initialIndex)
  const index = Math.min(selected, Math.max(0, sources.length - 1))
  const rail = useRef<HTMLDivElement>(null)
  useEffect(() => {
    rail.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [index])
  if (!sources.length) return <p className="bl-note">{t.failed}</p>
  return <div className="image-viewer">
    <ImageStage key={sources[index]} src={sources[index]} title={title} traceContext={traceContext}
      previous={sources.length > 1 ? (index > 0 ? () => setSelected(index - 1) : undefined) : previous}
      next={sources.length > 1 ? (index < sources.length - 1 ? () => setSelected(index + 1) : undefined) : next} />
    {sources.length > 1 && <div className="iv-gallery" ref={rail} role="group" aria-label={t.gallery}>
      {sources.map((src, i) => <button key={`${src}-${i}`} className="iv-thumbnail" aria-current={i === index ? 'true' : undefined} aria-label={`${t.image} ${i + 1} / ${sources.length}`} onClick={() => setSelected(i)}><img src={mediaUrl(src, BRIDGE_HTTP_URL)} alt="" loading="lazy" /><span>{i + 1}</span></button>)}
    </div>}
  </div>
}
