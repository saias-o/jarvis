export type ImageView = { scale: number; x: number; y: number }
export type ImageSize = { width: number; height: number }
export const FIT_VIEW: ImageView = { scale: 1, x: 0, y: 0 }
export const MAX_IMAGE_ZOOM = 6

export function fitImage(image: ImageSize, viewport: ImageSize): ImageSize {
  if (!image.width || !image.height || !viewport.width || !viewport.height) return { width: 0, height: 0 }
  const ratio = Math.min(viewport.width / image.width, viewport.height / image.height)
  return { width: image.width * ratio, height: image.height * ratio }
}

export function constrainView(view: ImageView, image: ImageSize, viewport: ImageSize): ImageView {
  const scale = Math.max(1, Math.min(MAX_IMAGE_ZOOM, view.scale))
  const maxX = Math.max(0, (image.width * scale - viewport.width) / 2)
  const maxY = Math.max(0, (image.height * scale - viewport.height) / 2)
  return { scale, x: maxX ? Math.max(-maxX, Math.min(maxX, view.x)) : 0, y: maxY ? Math.max(-maxY, Math.min(maxY, view.y)) : 0 }
}

/** Keep the image point under the fingers stationary while zooming. */
export function zoomImage(view: ImageView, scale: number, point: { x: number; y: number }, image: ImageSize, viewport: ImageSize): ImageView {
  const next = Math.max(1, Math.min(MAX_IMAGE_ZOOM, scale))
  const ratio = next / view.scale
  return constrainView({ scale: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }, image, viewport)
}

/** Stable history order, independent of which card is lifted to the front. */
export function adjacentBlade<T extends { id: string }>(items: T[], id: string | undefined, by: number): T | undefined {
  if (!items.length) return undefined
  const index = Math.max(0, items.findIndex((item) => item.id === id))
  return items[((index + by) % items.length + items.length) % items.length]
}
