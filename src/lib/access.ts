import { saveAccessToken } from './bridgeAuth'
import { isAndroid } from './android'
import { readDeviceSettings } from './deviceSettings'
import { bridgeFetch } from './bridgeAuth'
import { BACKEND, BRIDGE_HTTP_URL } from '../config'

/**
 * The access code, for a device that is not the machine JARVIS runs on.
 *
 * On the computer itself the bridge asks for nothing and this resolves 'open'
 * without anyone noticing it ran. Reached from a phone, the bridge's remote
 * port wants its code once, and trades it for a cookie the browser then sends
 * on everything — the socket, the speech endpoints, every image on a blade. So
 * nothing else in the app knows a code exists: by the time it runs, the cookie
 * is either there or this module has the screen.
 *
 * The code itself is never kept here. The cookie is the device's proof, it is
 * HttpOnly, and losing it costs eight characters of typing.
 */

export type Access = 'checking' | 'open' | 'locked'

export async function checkAccess(): Promise<'open' | 'locked'> {
  if (BACKEND !== 'bridge' || (isAndroid && readDeviceSettings().mode !== 'pc')) return 'open'
  try {
    const res = await bridgeFetch(`${BRIDGE_HTTP_URL}/auth`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    })
    // A bridge that has never heard of /auth is one with no remote port.
    if (!res.ok) return 'open'
    const state = (await res.json()) as { required?: boolean; ok?: boolean }
    return state.required && !state.ok ? 'locked' : 'open'
  } catch {
    // Unreachable is not locked. Power-up reports a bridge that is not there,
    // and says so better than a code prompt that can never succeed.
    return 'open'
  }
}

export type CodeVerdict = 'ok' | 'wrong' | 'locked' | 'unreachable'

export async function submitCode(code: string): Promise<CodeVerdict> {
  try {
    const res = await bridgeFetch(`${BRIDGE_HTTP_URL}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(6000),
    })
    if (res.ok) {
      const state = await res.json()
      if (state.token) saveAccessToken(state.token)
      return 'ok'
    }
    return res.status === 429 ? 'locked' : 'wrong'
  } catch {
    return 'unreachable'
  }
}
