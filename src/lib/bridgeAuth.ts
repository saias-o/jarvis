import { BRIDGE_HTTP_URL } from '../config'

export function accessToken(): string {
  try { return sessionStorage.getItem(`jarvis-access:${BRIDGE_HTTP_URL}`) ?? '' }
  catch { return '' }
}

export function saveAccessToken(token: string): void {
  sessionStorage.setItem(`jarvis-access:${BRIDGE_HTTP_URL}`, token)
}

export function bridgeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = accessToken()
  if (token && new URL(input).origin === new URL(BRIDGE_HTTP_URL).origin) headers.set('authorization', `Bearer ${token}`)
  return fetch(input, { ...init, headers })
}
