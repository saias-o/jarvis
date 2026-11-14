import { useRef, useState, type FormEvent } from 'react'
import { useStore } from '../store'
import { IS_FRENCH } from '../config'
import { usingBridge } from '../lib/brain'
import { handFiles } from '../lib/upload'

/**
 * Writing to him instead of speaking.
 *
 * There are plenty of places a voice assistant cannot be spoken to — a train,
 * a meeting, a room with someone asleep in it — and on a phone those are most
 * of the places it gets used. A typed line goes down exactly the path a spoken
 * one does: it becomes the turn, it cuts off whatever he was saying, and the
 * answer arrives the same way. Nothing here needs the microphone, so it also
 * works when the browser has refused one.
 *
 * It is also where a file is handed over on a device with nothing to drag: the
 * clip opens the system's own picker. Files wait above the field until the
 * next thing said, typed or spoken, and go with it.
 *
 * App's key handler already stands aside for anything typed into an <input>,
 * so space, V, G and T are just letters while this has focus.
 */
export function Ask({ onSend }: { onSend: (text: string) => void }) {
  const phase = useStore((s) => s.phase)
  const attachments = useStore((s) => s.attachments)
  const removeAttachment = useStore((s) => s.removeAttachment)
  const [text, setText] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  if (phase === 'offline' || phase === 'boot') return null

  const ready = attachments.some((a) => a.state === 'ready')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const said = text.trim()
    // A file with nothing said is still a turn: he asks what to do with it.
    if (!said && !ready) return
    setText('')
    // On a touch screen the keyboard is covering the answer; put it away.
    if (window.matchMedia('(pointer: coarse)').matches) field.current?.blur()
    onSend(said)
  }

  return (
    <form className="ask" onSubmit={submit}>
      {attachments.length > 0 && (
        <ul className="ask-files">
          {attachments.map((a) => (
            <li key={a.id} className={`ask-file ask-file-${a.state}`}>
              <span className="ask-file-name">{a.name}</span>
              <span className="ask-file-state">
                {a.state === 'sending'
                  ? IS_FRENCH ? 'envoi…' : 'sending…'
                  : a.state === 'failed'
                    ? IS_FRENCH ? 'échec' : 'failed'
                    : ''}
              </span>
              <button
                type="button"
                className="ask-file-remove"
                onClick={() => removeAttachment(a.id)}
                aria-label={IS_FRENCH ? `Retirer ${a.name}` : `Remove ${a.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {usingBridge && (
        <>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) void handFiles(Array.from(e.target.files))
              // Cleared so picking the same file twice in a row still fires.
              e.target.value = ''
            }}
          />
          <button
            className="ask-attach"
            type="button"
            onClick={() => picker.current?.click()}
            aria-label={IS_FRENCH ? 'Donner un fichier à Jarvis' : 'Give Jarvis a file'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 11.5 12 18.5a4.2 4.2 0 0 1-6-6l7.5-7.5a2.8 2.8 0 0 1 4 4L10 16.5a1.4 1.4 0 0 1-2-2l6.5-6.5" />
            </svg>
          </button>
        </>
      )}
      <input
        ref={field}
        className="ask-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={IS_FRENCH ? 'Écrire à Jarvis…' : 'Message Jarvis…'}
        aria-label={IS_FRENCH ? 'Message pour Jarvis' : 'Message for Jarvis'}
        autoComplete="off"
        enterKeyHint="send"
        maxLength={2000}
      />
      <button
        className="ask-send"
        type="submit"
        disabled={!text.trim() && !ready}
        aria-label={IS_FRENCH ? 'Envoyer' : 'Send'}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h13M12.5 6.5 18 12l-5.5 5.5" />
        </svg>
      </button>
    </form>
  )
}
