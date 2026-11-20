// Which language is being spoken, so the voice can follow it.
//
//   node --test test/
//
// The detector judges one or two sentences of ordinary conversation, which is
// all this interface ever hands it: a question asked out loud, and an answer
// under twelve words. The cases below are the ones that decide whether a
// French answer is read by a French voice or spelled out phonetically by an
// English one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tsImport } from 'tsx/esm/api'

const { detect, tagFor, spoken, noteSpoken, resetSpoken } =
  await tsImport('../src/lib/language.ts', import.meta.url)

test('ordinary French and English are told apart', () => {
  for (const line of [
    'Quelle heure est-il ?',
    'Ouvre le dossier et dis-moi ce qu’il y a dedans',
    'La batterie est à onze pour cent, monsieur.',
    'Je ne trouve rien de tel.',
    'Oui',
    'Montre-moi la caméra',
  ]) assert.equal(detect(line), 'fr', line)

  for (const line of [
    'What time is it?',
    'Open the folder and tell me what is in it',
    'The battery is at eleven percent, sir.',
    'I have no record of it.',
    'Yes',
    'Show me the camera',
  ]) assert.equal(detect(line), 'en', line)
})

test('a sentence with no evidence says so rather than guessing', () => {
  for (const line of ['', '   ', '42', 'MARK VII', 'JARVIS', 'npm run build', '...']) {
    assert.equal(detect(line), null, JSON.stringify(line))
  }
})

test('the conversation holds its language until the words change it', () => {
  resetSpoken()
  const start = spoken()
  // Something that says nothing leaves it where it was — a bare number must
  // not flip the voice mid-conversation.
  assert.equal(noteSpoken('42'), start)
  assert.equal(noteSpoken('Ouvre la caméra et regarde'), 'fr')
  assert.equal(noteSpoken('MARK VII'), 'fr', 'held through an undecidable turn')
  assert.equal(noteSpoken('What can you see?'), 'en')
  resetSpoken()
})

test('a language is given a speech tag, keeping the configured region', () => {
  // The default here is en-GB, so English keeps the configured tag and French
  // gets the one this project is written around.
  assert.equal(tagFor('en'), 'en-GB')
  assert.equal(tagFor('fr'), 'fr-FR')
})

test('accents and elisions count for French without outvoting a sentence', () => {
  assert.equal(detect('déjà'), 'fr')
  assert.equal(detect('l’heure'), 'fr')
  // Three accented letters cannot carry a line that is otherwise English: the
  // café/fiancé/naïve problem, where an English sentence borrows a word.
  assert.equal(detect('I was at the café with my fiancé and it was naïve of me'), 'en')
})
