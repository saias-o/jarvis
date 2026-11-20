/**
 * Which language is being spoken, sentence by sentence.
 *
 * JARVIS answers in whatever language he is addressed in — the system prompt
 * says so and the models do it — but the voice did not follow: one tag from
 * VITE_VOICE_LANG decided the recognizer, the system voice and the canned
 * lines for the whole session. Ask him something in French on an en-GB setup
 * and a British voice read the French answer out phonetically, which is worse
 * than an accent; it is unintelligible.
 *
 * So the language is read off the words instead. Two of them, French and
 * English, because those are the two the interface has lines written in; the
 * detector returns null rather than guess when a sentence carries no evidence
 * either way, and the caller keeps whatever was being spoken before.
 *
 * This is a stopword counter, not a classifier, and that is the right size for
 * the job: the things it has to judge are one or two sentences of ordinary
 * conversation, where "the" and "le" settle it in the first three words. It
 * would be hopeless on a proper noun or a code snippet — which is exactly when
 * it returns null.
 */

export type Lang = 'fr' | 'en'

/**
 * The configured tag lives here rather than in config.ts, and config.ts
 * re-exports it, so there is still exactly one definition of it.
 *
 * It is read defensively because this module is exercised by the Node test
 * suite, where import.meta.env does not exist at all — and because a detector
 * worth trusting is one with tests, which means it cannot drag the whole
 * browser configuration in behind it.
 *
 * The language JARVIS starts in, as a BCP 47 tag: the browser's speech
 * recognition opens in it, the first voice is picked from it, and the canned
 * lines follow it until the conversation says otherwise.
 *   en-GB — the character as written (default)
 *   fr-FR — French; any other tag works for recognition and voice choice,
 *           with the canned lines falling back to English
 */
const META_ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
export const VOICE_LANG = META_ENV.VITE_VOICE_LANG?.trim() || 'en-GB'

/** True when VOICE_LANG is French (fr-FR, fr-CA, fr-BE …). */
export const IS_FRENCH = /^fr\b/i.test(VOICE_LANG)

/**
 * Words that are common in one language and rare or absent in the other.
 *
 * The ones they share are deliberately missing: `on`, `en`, `son`, `car`,
 * `or`, `a`, `pour` against `pour` — anything ambiguous adds noise to both
 * sides at once and makes a short sentence a coin toss. `sir` and `monsieur`
 * are in because this assistant says one of them in most of its answers.
 */
const FRENCH_WORDS =
  /\b(je|tu|il|elle|nous|vous|ils|elles|le|la|les|un|une|des|du|de|et|est|sont|pour|avec|dans|sur|que|qui|quoi|ne|pas|plus|tout|toute|tous|oui|non|monsieur|merci|quel|quelle|comment|pourquoi|où|ça|ce|cette|ces|mon|ma|mes|ton|votre|leur|bien|peux|peut|fais|fait|faire|suis|être|avoir|donc|alors|aussi|encore|jamais|toujours|maintenant|après|avant|voici|voilà|très|trop|moins|chez|sans|sous|entre|depuis|pendant|rien|déjà|ici|bonjour|bonsoir)\b/gi

const ENGLISH_WORDS =
  /\b(the|a|an|and|is|are|was|were|for|with|in|on|at|of|to|that|which|not|all|i|you|he|she|we|they|yes|no|sir|thanks|thank|what|why|how|where|when|this|these|those|my|your|their|well|can|could|would|should|do|does|did|make|have|has|had|it|its|from|about|into|over|after|before|now|just|only|here|there|nothing|already)\b/gi

/** é, à, ç and the rest: present in French, essentially never in English. */
const ACCENTS = /[àâäçéèêëîïôöùûüÿœæ]/gi

/** l', d', qu', n', j', c', s', m', t' — elision is French and nothing else. */
const ELISIONS = /\b[cdjlmnst]['’]|\bqu['’]/gi

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0

/**
 * The language of one piece of text, or null when it does not say.
 *
 * Accents and elisions are capped so that a single heavily accented word
 * cannot outvote a sentence of English, and a tie returns null: an honest
 * "I cannot tell" is what lets the caller hold the language steady instead of
 * flipping the voice on the word "non".
 */
export function detect(text: string): Lang | null {
  const words = String(text ?? '')
  if (!words.trim()) return null

  const french = count(words, FRENCH_WORDS)
    + Math.min(count(words, ACCENTS), 3)
    + Math.min(count(words, ELISIONS), 2)
  const english = count(words, ENGLISH_WORDS)

  if (french === english) return null
  return french > english ? 'fr' : 'en'
}

/** What the tag in VITE_VOICE_LANG asks for; where a session starts. */
export const DEFAULT_LANG: Lang = IS_FRENCH ? 'fr' : 'en'

let current: Lang = DEFAULT_LANG

/** The language the conversation is being held in. */
export const spoken = (): Lang => current

/**
 * Note what the user just said or typed. Their words decide, not the answer:
 * "speak to me in French" is a French sentence whoever ends up answering it,
 * and this is what the microphone and the canned lines follow for the next
 * turn.
 */
export function noteSpoken(text: string): Lang {
  const found = detect(text)
  if (found) current = found
  return current
}

/** Back to the configured language — a new conversation is not the old one. */
export function resetSpoken(): void {
  current = DEFAULT_LANG
}

/**
 * A BCP 47 tag for a language.
 *
 * VITE_VOICE_LANG wins for its own language, so a machine set to fr-CA or
 * en-US keeps its region; the other language gets the tag this project is
 * written around.
 */
export function tagFor(lang: Lang): string {
  if (lang === DEFAULT_LANG) return VOICE_LANG
  return lang === 'fr' ? 'fr-FR' : 'en-GB'
}
