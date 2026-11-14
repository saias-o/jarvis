import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tsImport } from 'tsx/esm/api'

const { fitImage, constrainView, zoomImage, adjacentBlade } = await tsImport('../src/lib/imageViewport.ts', import.meta.url)

test('landscape PC screenshots and portrait images fit without cropping', () => {
  assert.deepEqual(fitImage({ width: 1920, height: 1080 }, { width: 400, height: 700 }), { width: 400, height: 225 })
  assert.deepEqual(fitImage({ width: 900, height: 1600 }, { width: 400, height: 700 }), { width: 393.75, height: 700 })
  assert.deepEqual(fitImage({ width: 0, height: 0 }, { width: 400, height: 700 }), { width: 0, height: 0 })
})

test('pinch zoom keeps the point under the fingers in place', () => {
  const size = { width: 400, height: 400 }
  const view = zoomImage({ scale: 1, x: 0, y: 0 }, 2, { x: 100, y: -50 }, size, size)
  assert.deepEqual(view, { scale: 2, x: -100, y: 50 })
  // The image point that was at (100, -50) still maps to that screen point.
  assert.equal(100 * view.scale + view.x, 100)
  assert.equal(-50 * view.scale + view.y, -50)
})

test('panning stops at image edges and never drags a short image out of view', () => {
  assert.deepEqual(constrainView({ scale: 2, x: 900, y: -900 }, { width: 400, height: 225 }, { width: 400, height: 700 }), { scale: 2, x: 200, y: 0 })
  assert.deepEqual(constrainView({ scale: 3, x: -900, y: 900 }, { width: 400, height: 400 }, { width: 400, height: 400 }), { scale: 3, x: -400, y: 400 })
})

test('zoom limits and returning to fit remove stale pan offsets', () => {
  const size = { width: 400, height: 400 }
  assert.deepEqual(zoomImage({ scale: 4, x: 200, y: -100 }, 0.1, { x: 50, y: 50 }, size, size), { scale: 1, x: 0, y: 0 })
  assert.equal(zoomImage({ scale: 1, x: 0, y: 0 }, 100, { x: 0, y: 0 }, size, size).scale, 6)
})

test('rotating the phone constrains pan against the new viewport', () => {
  const viewport = { width: 740, height: 320 }
  const fitted = fitImage({ width: 1920, height: 1080 }, viewport)
  const view = constrainView({ scale: 2, x: 700, y: -700 }, fitted, viewport)
  assert.equal(view.y, -160)
  assert.ok(view.x <= (fitted.width * 2 - viewport.width) / 2)
})

test('repeated navigation visits every capture instead of oscillating between two', () => {
  const history = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  let active = 'a'
  const visited = []
  for (let i = 0; i < 4; i++) {
    active = adjacentBlade(history, active, 1).id
    visited.push(active)
  }
  assert.deepEqual(visited, ['b', 'c', 'a', 'b'])
  assert.equal(adjacentBlade(history, 'a', -1).id, 'c')
  assert.equal(adjacentBlade([], 'a', 1), undefined)
})
