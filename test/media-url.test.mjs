import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tsImport } from 'tsx/esm/api'

const { diskPath } = await tsImport('../src/lib/diskPath.ts', import.meta.url)
const { mediaUrl } = await tsImport('../src/lib/mediaUrl.ts', import.meta.url)

const MOBILE = 'https://pc.example.ts.net'
const LOCAL = 'http://localhost:8787'
const shot = 'C:\\Users\\you\\Pictures\\capture 100%.png'

test('Windows screenshot paths and file URLs reach the PC through the mobile bridge', () => {
  for (const source of [shot, `/${shot}`, 'file:///C:/Users/you/Pictures/capture%20100%25.png',
    'file:/C:/Users/you/Pictures/capture%20100%25.png',
    'file://localhost/C:/Users/you/Pictures/capture%20100%25.png']) {
    const url = new URL(mediaUrl(source, MOBILE))
    assert.equal(url.origin, MOBILE)
    assert.equal(url.pathname, '/file')
    assert.equal(url.searchParams.get('path').replaceAll('\\', '/'), shot.replaceAll('\\', '/'))
  }
})

test('PC localhost media URLs use the phone connection instead of a second proxy', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    for (const route of ['file?path=' + encodeURIComponent(shot),
      'img?url=https%3A%2F%2Fexample.com%2Fa.png&sig=abc',
      'media?url=https%3A%2F%2Fexample.com%2Fa.mp4']) {
      assert.equal(mediaUrl(`http://${host}:8787/${route}`, MOBILE), `${MOBILE}/${route}`)
      assert.equal(mediaUrl(`http://${host}:8788/${route}`, MOBILE), `${MOBILE}/${route}`)
    }
  }
  assert.equal(mediaUrl(`${LOCAL}/file?path=x`, LOCAL), `${LOCAL}/file?path=x`)
})

test('ordinary web images still use the proxy and assets and inline images are preserved', () => {
  const remote = 'https://example.com/image.png'
  assert.equal(mediaUrl(remote, MOBILE), `${MOBILE}/img?url=${encodeURIComponent(remote)}`)
  assert.equal(mediaUrl(remote, MOBILE, 'media'), `${MOBILE}/media?url=${encodeURIComponent(remote)}`)
  for (const src of ['/icon.svg', '/assets/icon.png', '/file?path=x', 'data:image/png;base64,abc', 'blob:https://pc.example.ts.net/id']) {
    assert.equal(mediaUrl(src, MOBILE), src)
  }
  assert.equal(mediaUrl(`${MOBILE}/file?path=x`, MOBILE), `${MOBILE}/file?path=x`)
  // Matching the word localhost in a public hostname must not rebase it.
  const lookalike = 'http://localhost.example.com:8787/file?path=x'
  assert.equal(mediaUrl(lookalike, MOBILE), `${MOBILE}/img?url=${encodeURIComponent(lookalike)}`)
  assert.equal(mediaUrl('http://[invalid', MOBILE), '')
})

test('explicit local file URLs can use any root without treating app assets as disk files', () => {
  assert.equal(diskPath('file:///screenshots/shot%20one.png'), '/screenshots/shot one.png')
  assert.equal(diskPath('/tmp/capture 100%.png'), '/tmp/capture 100%.png')
  assert.equal(diskPath('file://other-pc/share/shot.png'), null)
  assert.equal(diskPath('/assets/icon.png'), null)
})
