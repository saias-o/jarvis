import { BRIDGE_HTTP_URL } from '../config'

export function accessToken(bridge = BRIDGE_HTTP_URL): string {
  try { return sessionStorage.getItem(`jarvis-access:${bridge}`) ?? '' }
  catch { return '' }
}

export function saveAccessToken(token: string): void {
  sessionStorage.setItem(`jarvis-access:${BRIDGE_HTTP_URL}`, token)
}

export function bridgeFetch(input: string, init: RequestInit = {}, bridge = BRIDGE_HTTP_URL): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = accessToken(bridge)
  if (token && new URL(input).origin === new URL(bridge).origin) headers.set('authorization', `Bearer ${token}`)
  return fetch(input, { ...init, headers })
}
