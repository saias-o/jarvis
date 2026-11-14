/** The same name and recognition variants on every device. */
const NAME = "(?:jarvis|jarvys|jervis|travis|jarviss|java's|jarv|djarvis|jarvi)\\b(?!'s)"
const PREFIX = '(?:hey|hi|ok|okay|yo|hé|eh|et)?\\s*'
const WAKE = new RegExp(`\\b${PREFIX}${NAME}`, 'i')
const LEADING = new RegExp(`^${PREFIX}${NAME}[\\s,.:;!?-]*`, 'i')

/** null means no wake phrase; an empty trailing string means just his name. */
export function wakePhrase(text) {
  const match = WAKE.exec(text)
  return match ? { trailing: text.slice(match.index + match[0].length).replace(/^[\s,.:;!?-]+/, '').trim() } : null
}

export function withoutVocative(text) {
  return text.trim().replace(LEADING, '').trim()
}
