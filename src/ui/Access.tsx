import { useState, type FormEvent } from 'react'
import { IS_FRENCH } from '../config'
import { submitCode } from '../lib/access'

/**
 * The lock, shown on a device that has not been paired yet.
 *
 * Sits over the ignition screen rather than replacing it: nothing behind it can
 * be reached, and the moment the code is accepted it is simply gone and the
 * interface underneath is exactly as it would have been on the computer.
 */

const T = IS_FRENCH
  ? {
      title: 'Accès à distance',
      sub: 'Saisissez le code affiché sur l’ordinateur.',
      go: 'Déverrouiller',
      wrong: 'Code incorrect.',
      locked: 'Trop d’essais. Réessayez dans cinq minutes.',
      unreachable: 'Ordinateur injoignable.',
    }
  : {
      title: 'Remote access',
      sub: 'Enter the code shown on the computer.',
      go: 'Unlock',
      wrong: 'That code is not right.',
      locked: 'Too many attempts. Try again in five minutes.',
      unreachable: 'The computer cannot be reached.',
    }

/** XXXX-XXXX as it is typed, so eight characters read as two short groups. */
const shape = (raw: string) => {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

export function AccessGate({ onOpen }: { onOpen: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const ready = code.replace('-', '').length === 8

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setProblem(null)
    const verdict = await submitCode(code)
    setBusy(false)
    if (verdict === 'ok') return onOpen()
    setProblem(T[verdict])
    if (verdict === 'wrong') setCode('')
  }

  return (
    <form className="access" onSubmit={submit}>
      <div className="access-box">
        <span className="access-mark">J.A.R.V.I.S.</span>
        <span className="access-title">{T.title}</span>
        <label className="access-sub" htmlFor="access-code">
          {T.sub}
        </label>
        <input
          id="access-code"
          className="access-input"
          value={code}
          onChange={(e) => setCode(shape(e.target.value))}
          placeholder="XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="go"
          autoFocus
        />
        <button className="access-go" type="submit" disabled={!ready || busy}>
          {T.go}
        </button>
        <span className="access-problem" role="alert">
          {problem ?? ''}
        </span>
      </div>
    </form>
  )
}
