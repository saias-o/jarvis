export type DeviceSettings = { mode: 'auto' | 'pc' | 'device'; pcs: string[]; backend: 'gpu' | 'cpu'; wifiOnly: boolean }
const KEY = 'jarvis-device-settings-v1'

export function readDeviceSettings(): DeviceSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return {
      mode: ['auto', 'pc', 'device'].includes(saved.mode) ? saved.mode : 'auto',
      pcs: Array.isArray(saved.pcs) ? saved.pcs.filter((v: unknown) => typeof v === 'string').slice(0, 8) : [],
      backend: saved.backend === 'cpu' ? 'cpu' : 'gpu',
      wifiOnly: saved.wifiOnly !== false,
    }
  } catch { return { mode: 'auto', pcs: [], backend: 'gpu', wifiOnly: true } }
}

export function pcAddress(raw: string): string {
  const url = new URL(raw.trim())
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Utilisez une adresse Tailscale HTTPS : https://pc.nom.ts.net')
  return url.origin
}

export function saveDeviceSettings(settings: DeviceSettings): void {
  localStorage.setItem(KEY, JSON.stringify({ ...settings, pcs: settings.pcs.map(pcAddress) }))
}
