/**
 * Enforce the catalogue's own schema at the executable boundary on either device.
 *
 * This ran on zod, which did it correctly and at a price the phone paid twice:
 * a 274 kB chunk fetched over the network before the first tool of a session
 * could run, and a JSON-Schema-to-zod conversion on top. The catalogue's
 * schemas are hand-written and a few lines each, and between all sixty-odd
 * tools they use exactly this much of JSON Schema:
 *
 *   an object with `properties` and `required`; leaves of type string, number,
 *   boolean, array (with `items` naming one leaf type) and object (with its
 *   own `properties`); `enum`; and one property with no `type` at all, which
 *   takes anything.
 *
 * So that is what this validates. Anything else in a schema is ignored rather
 * than guessed at — a new keyword silently not being enforced is a worse
 * failure than one loudly unsupported, so if you reach for one, teach it here.
 *
 * The messages are zod's, word for word, because they are good ones and
 * because they are what the models have been reading: a tool call that fails
 * the same way it failed last week gets corrected the same way.
 *
 * The bridge still uses zod, in device-server.mjs, where the Claude SDK wants
 * a zod shape and where a megabyte of node_modules costs nothing.
 *
 * Browser-safe.
 */

/** What zod calls the thing it received. */
const kindOf = (value) =>
  value === null ? 'null'
    : Array.isArray(value) ? 'array'
      : typeof value === 'number' && Number.isNaN(value) ? 'NaN'
        : typeof value

const where = (path, message) => (path ? `${path}: ${message}` : message)
const wrong = (path, expected, value) =>
  where(path, `Invalid input: expected ${expected}, received ${kindOf(value)}`)

/**
 * Collect every problem rather than stopping at the first: a model that gets
 * both mistakes back fixes both in one go.
 */
function check(value, schema, path, problems) {
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      const options = schema.enum.map((option) => JSON.stringify(option)).join('|')
      problems.push(where(path, `Invalid option: expected one of ${options}`))
    }
    return
  }

  const { type } = schema
  if (!type) return

  if (type === 'object') {
    if (kindOf(value) !== 'object') return problems.push(wrong(path, 'object', value))
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const field = value[name]
      if (field !== undefined) check(field, property, path ? `${path}.${name}` : name, problems)
    }
    return
  }

  if (type === 'array') {
    if (kindOf(value) !== 'array') return problems.push(wrong(path, 'array', value))
    if (schema.items) {
      value.forEach((item, index) => check(item, schema.items, `${path}.${index}`, problems))
    }
    return
  }

  if (kindOf(value) !== type) problems.push(wrong(path, type, value))
}

/** Absent keys, so a tool reading `args.x` cannot tell a missing one from an explicit undefined. */
const strip = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, strip(item)]),
    )
    : value

/** The arguments as the tool should see them, or a throw naming everything wrong with them. */
export function validateArguments(name, schema, args) {
  const problems = []
  if (kindOf(args) !== 'object') {
    problems.push(wrong('', 'object', args))
  } else {
    for (const required of schema?.required ?? []) {
      if (args[required] !== undefined) continue
      const property = schema.properties?.[required]
      if (Array.isArray(property?.enum)) {
        // A missing choice is reported as a bad choice, which is the more
        // useful of the two: it names the options.
        check(undefined, property, required, problems)
      } else {
        // A property with no type of its own is still required; zod calls that
        // one 'nonoptional', having nothing else to call it.
        problems.push(wrong(required, property?.type ?? 'nonoptional', undefined))
      }
    }
    check(args, schema ?? {}, '', problems)
  }
  if (problems.length) throw new Error(`Invalid arguments for ${name}: ${problems.join('; ')}`)
  return strip(args)
}

export function validatedTool(tool) {
  return {
    ...tool,
    async run(args, options) {
      options?.signal?.throwIfAborted()
      const checked = validateArguments(tool.name, tool.parameters, args)
      options?.signal?.throwIfAborted()
      return tool.run(checked, options)
    },
  }
}
