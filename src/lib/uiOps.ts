import { useStore } from '../store'

/**
 * Applies one interface operation from the ui_* tools (shared/ui-tools.mjs).
 *
 * The same function serves both supports: on the PC the bridge pushes the
 * operation down the socket mid-turn; on the phone the tools call it directly.
 * The op/args pair is untyped up to here on purpose, the store decides the shape.
 */
export function applyUiOp(op: string, args: unknown): void {
  const s = useStore.getState()
  const a = (args ?? {}) as Record<string, never>
  switch (op) {
    case 'patch':
      s.applyUi(args as Parameters<typeof s.applyUi>[0])
      break
    case 'orbit':
      if (a.action === 'add') s.addOrbit(args as Parameters<typeof s.addOrbit>[0])
      else if (a.action === 'remove') s.removeOrbit(String(a.id))
      else s.clearOrbits()
      break
    case 'effect':
      s.fireEffect(a.kind)
      break
    case 'reset':
      s.resetUi()
      break
    case 'screen':
      s.clearScreen(a.what ?? 'all')
      break
    default:
      console.warn('[jarvis] unknown ui op:', op, args)
  }
}
