import { useSyncExternalStore } from 'react'

const QUERY = '(pointer: coarse), (max-width: 760px)'
const subscribe = (notify: () => void) => {
  const query = window.matchMedia(QUERY)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
const snapshot = () => window.matchMedia(QUERY).matches

export function useMobileLayout() {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
