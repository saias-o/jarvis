/**
 * Tools in named groups, for a model whose context cannot hold every schema.
 *
 * The model starts a turn with the first group, plus the tools kept in every
 * group (`show`), and loads another with `select_tools`. The other groups are
 * named and described, so it knows where to switch without paying for their
 * schemas. A large model is simply offered every tool and no selector.
 *
 * Used for on-device Gemma on the phone and for the PC's local model; the
 * groups themselves are each device's.
 *
 * Browser-safe.
 */
import { validatedTool } from './tool-validation.mjs'

/**
 * @param {Record<string, string>} descriptions  Each group and what it is for, in order; the first is where a turn starts.
 * @param {Record<string, Array<{ name: string }>>} groups
 * @param {{ keep?: string[] }} [options]  Tool names offered whatever the group.
 */
export function toolGroups(descriptions, groups, { keep = ['show'] } = {}) {
  const order = Object.keys(descriptions)
  let selected = order[0]
  const names = (tools) => tools.map((tool) => tool.name).join(', ')
  const available = () => order.filter((group) => groups[group]?.length)
  const switchable = () => available().length > 1
  const selector = validatedTool({
    name: 'select_tools',
    description: `Switch to this tool group for the next steps; ${keep.join(', ') || 'nothing else'} stays.`,
    parameters: { type: 'object', properties: { group: { type: 'string', enum: order } }, required: ['group'] },
    run({ group }) {
      if (!groups[group]?.length) throw new Error(`The ${group} tools are not available now.`)
      selected = group
      return names(groups[group])
    },
  })
  return {
    selector,
    selected: () => selected,
    switchable,
    /** The tools of one group, empty when it has none. */
    tools: (group) => groups[group] ?? [],
    /** Replace a group's tools, e.g. when a device goes away mid-turn. */
    set(group, tools) {
      groups[group] = tools
      if (!groups[selected]?.length) selected = order[0]
    },
    /** The groups not offered right now, described, for the prompt. */
    others: () => available().filter((group) => group !== selected).map((group) => `${group} = ${descriptions[group]}`),
    /** The tool entries offered now, from the whole catalogue: kept tools, the group, the selector. */
    current(all) {
      const kept = all.filter((tool) => keep.includes(tool.name) && !groups[selected].includes(tool))
      return [...kept, ...groups[selected], ...(switchable() ? [selector] : [])]
    },
    /** The schemas offered now, from every schema of the turn. */
    offer(specs) {
      const offered = new Set([...keep, ...groups[selected].map((tool) => tool.name)])
      if (switchable()) offered.add(selector.name)
      return specs.filter(({ function: fn }) => offered.has(fn.name))
    },
  }
}
