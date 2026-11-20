// The catalogue's own schema, enforced at the executable boundary.
//
//   node --test test/
//
// These expectations are zod's, recorded from the version this used to run on
// and checked against every schema in the catalogue before the swap: 783
// combinations of tool and argument, no difference. They are pinned here
// because the wording is what a model reads when it gets a call wrong, and a
// model that is corrected the same way every time corrects itself faster.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateArguments, validatedTool } from '../shared/tool-validation.mjs'

const schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'where' },
    count: { type: 'number' },
    flag: { type: 'boolean' },
    kind: { type: 'string', enum: ['all', 'documents'] },
    images: { type: 'array', items: { type: 'string' } },
    nested: { type: 'object', properties: { a: { type: 'string' } } },
    anything: { description: 'no type of its own' },
  },
  required: ['path'],
}

const refused = (args, expected) => {
  assert.throws(() => validateArguments('demo', schema, args), (error) => {
    assert.equal(error.message, `Invalid arguments for demo: ${expected}`)
    return true
  })
}

test('arguments that fit come back, extras and all', () => {
  const args = { path: 'a', count: 2, flag: true, kind: 'all', images: ['x'], nested: { a: 'b' }, anything: 7 }
  assert.deepEqual(validateArguments('demo', schema, args), args)
  // Unknown keys are kept: a model volunteering something is not an error, and
  // the tool reads the arguments it knows about.
  assert.deepEqual(validateArguments('demo', schema, { path: 'a', surprise: 1 }), { path: 'a', surprise: 1 })
  // An explicit undefined is an absent key, so a tool's own default applies.
  assert.deepEqual(validateArguments('demo', schema, { path: 'a', count: undefined }), { path: 'a' })
})

test('every problem is named at once, by path', () => {
  refused({ count: 1 }, 'path: Invalid input: expected string, received undefined')
  refused({ path: 5 }, 'path: Invalid input: expected string, received number')
  refused({ path: 'a', count: '3' }, 'count: Invalid input: expected number, received string')
  refused({ path: 'a', count: null }, 'count: Invalid input: expected number, received null')
  refused({ path: 'a', nested: { a: 1 } }, 'nested.a: Invalid input: expected string, received number')
  refused({ path: 'a', nested: ['x'] }, 'nested: Invalid input: expected object, received array')
  refused({ path: 'a', images: [1] }, 'images.0: Invalid input: expected string, received number')
  refused({ path: 'a', images: { 0: 'x' } }, 'images: Invalid input: expected array, received object')
  refused(null, 'Invalid input: expected object, received null')
  refused({ path: 5, count: 'x' },
    'path: Invalid input: expected string, received number; count: Invalid input: expected number, received string')
})

test('a choice names the choices, present or absent', () => {
  refused({ path: 'a', kind: 'nope' }, 'kind: Invalid option: expected one of "all"|"documents"')
  refused({ path: 'a', kind: 3 }, 'kind: Invalid option: expected one of "all"|"documents"')
  // Absent and optional is fine; absent and required reports the options
  // rather than the type, which is the more useful of the two.
  assert.deepEqual(validateArguments('demo', schema, { path: 'a' }), { path: 'a' })
  const choose = { type: 'object', properties: { kind: { type: 'string', enum: ['x', 'y'] } }, required: ['kind'] }
  assert.throws(() => validateArguments('demo', choose, {}),
    { message: 'Invalid arguments for demo: kind: Invalid option: expected one of "x"|"y"' })
})

test('a required property with no type is still required', () => {
  const loose = { type: 'object', properties: { value: { description: 'anything' } }, required: ['value'] }
  assert.deepEqual(validateArguments('demo', loose, { value: false }), { value: false })
  assert.throws(() => validateArguments('demo', loose, {}),
    { message: 'Invalid arguments for demo: value: Invalid input: expected nonoptional, received undefined' })
})

test('a tool runs on checked arguments, and not at all on bad ones', async () => {
  let saw = null
  const tool = validatedTool({
    name: 'demo',
    parameters: schema,
    run: async (args) => { saw = args; return 'done' },
  })

  assert.equal(await tool.run({ path: 'a', count: undefined }), 'done')
  assert.deepEqual(saw, { path: 'a' })

  saw = null
  await assert.rejects(tool.run({ count: 1 }), /Invalid arguments for demo: path: /)
  assert.equal(saw, null, 'a refused call never reaches the tool')

  // An abort is noticed before the work starts, and again before it is handed on.
  const control = new AbortController()
  control.abort()
  await assert.rejects(tool.run({ path: 'a' }, { signal: control.signal }))
})
