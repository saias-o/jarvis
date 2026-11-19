/** Enforce the catalogue's own schema at the executable boundary on either device. */
export function validatedTool(tool) {
  let schema
  return {
    ...tool,
    async run(args, options) {
      options?.signal?.throwIfAborted()
      schema ??= (await import('zod')).z.fromJSONSchema(tool.parameters)
      const result = schema.safeParse(args)
      if (!result.success) {
        const reasons = result.error.issues.map((issue) => [issue.path.join('.'), issue.message].filter(Boolean).join(': '))
        throw new Error(`Invalid arguments for ${tool.name}: ${reasons.join('; ')}`)
      }
      options?.signal?.throwIfAborted()
      return tool.run(result.data, options)
    },
  }
}
