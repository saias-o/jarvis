/**
 * The phone's side of the device agent's tools.
 *
 * The tools themselves are the shared catalogue in shared/tools.mjs, the same
 * code the PC runs, whichever model is thinking. This file supplies only what
 * is the phone's own: its native file plugin, its screen and its HTTP client.
 */
import { deviceTools } from './tools.mjs'
import { agentContext } from './agent-context.mjs'
import { validatedTool } from './tool-validation.mjs'
import { boundedChat } from './context-window.mjs'
import { parseFacts } from './memory.mjs'
import { UI_TOOLS } from './ui-tools.mjs'

const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length

/** The newest remembered lines within a byte budget, oldest dropped first. */
export function recentFacts(text, maxBytes) {
  const lines = parseFacts(text)
  const kept = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = bytes(lines[i]) + 1
    if (used + cost > maxBytes) { kept.unshift('[faits plus anciens omis]'); break }
    kept.unshift(lines[i])
    used += cost
  }
  return kept.join('\n')
}

/** Select an inference provider and a reachable tool host independently, in preference order. */
export async function androidRoute({ mode, pcs }, probe) {
  const checks = pcs.map(async (url) => {
    try {
      const response = await probe(url)
      if (!response.ok) return { url, status: response.status }
      return { url, available: true, inference: (await response.json()).inference === 'android-v1' }
    } catch { return { url, available: false } }
  })
  let reachable, locked = false
  for (const check of checks) {
    const pc = await check
    if (pc.status === 401) locked = true
    if (!pc.available) continue
    reachable ??= pc.url
    if (mode === 'device') return { inference: 'device', pcUrl: pc.url }
    if (pc.inference) return { inference: 'pc', pcUrl: pc.url }
  }
  if (mode !== 'pc') return { inference: 'device', pcUrl: reachable ?? null }
  if (locked) throw new Error('Code d’accès requis : ouvrez Réglages Android.')
  if (reachable) throw new Error('Mettez à jour le serveur PC : inférence Android indisponible.')
  throw new Error('PC injoignable. Vérifiez Tailscale et son adresse dans Réglages Android.')
}

const GROUPS = { android: 'Android', interface: 'Interface', pc: 'PC' }

/**
 * The tools of one Android turn, in groups: the phone's files, memory and web
 * (android), its interface (interface) and the connected PC (pc). Larger
 * providers get every group directly. On-device Gemma gets one group at a time,
 * with `show`, and switches with select_tools: every group at once does not fit
 * its window.
 */
export function androidCatalogue(phone, pc) {
  let currentPc = pc
  const groups = {
    android: phone.tools.filter((tool) => !UI_TOOLS.has(tool.name)),
    interface: phone.tools.filter((tool) => UI_TOOLS.has(tool.name)),
    pc: pc.tools,
  }
  let selected = 'android'
  const available = () => Object.keys(GROUPS).filter((group) => groups[group].length)
  const switchable = () => available().length > 1
  const names = (tools) => tools.map((tool) => tool.name).join(', ')
  const selector = validatedTool({
    name: 'select_tools',
    description: 'Offer the tools of this group from the next step on. show stays available.',
    parameters: { type: 'object', properties: { group: { type: 'string', enum: Object.keys(GROUPS) } }, required: ['group'] },
    run({ group }) {
      if (!groups[group].length) throw new Error(`No ${GROUPS[group]} tools are available now.`)
      selected = group
      return names(groups[group])
    },
  })
  return {
    tools: [...phone.tools, ...pc.tools, selector],
    system: [phone.system, pc.system].filter(Boolean).join('\n'),
    updatePc(reachable) {
      currentPc = reachable
      groups.pc = pc.tools.filter((tool) => reachable.tools.some((other) => other.name === tool.name))
      if (!groups[selected].length) selected = 'android'
    },
    // Only the selected group's rules and facts: the other groups are named so
    // that the model knows it can switch, without paying for their schemas.
    localSystem() {
      const hosts = selected === 'pc' ? [currentPc.system] : selected === 'android' ? [phone.facts] : []
      if (!pc.tools.length) hosts.push(pc.system)
      else if (!groups.pc.length) hosts.push('Aucun outil PC disponible.')
      const others = available().filter((group) => group !== selected).map((group) => `${GROUPS[group]} : ${names(groups[group])}`)
      if (others.length) hosts.push(`Autres outils, après select_tools(group) : ${others.join(' ; ')}.`)
      const screen = selected === 'android' ? [] : phone.tools.filter((tool) => tool.name === 'show')
      return phone.compose([...screen, ...groups[selected], ...(switchable() ? [selector] : [])], hosts, true)
    },
    offer(specs, local) {
      if (!local) return specs.filter(({ function: fn }) => fn.name !== selector.name)
      const offered = new Set(['show', ...groups[selected].map((tool) => tool.name)])
      if (switchable()) offered.add(selector.name)
      return specs.filter(({ function: fn }) => offered.has(fn.name))
    },
  }
}

/**
 * @param {number} [context]  The thinking model's whole context in bytes, when
 *   it is small (on-device Gemma). One tool result is then sized to what the
 *   prompt and the schemas leave free, instead of overflowing the window.
 */
export async function androidTools(files, { show, ui, http, context, smallContext = () => true } = {}) {
  const storage = await files.status()
  const memory = await files.readMemory()
  const native = async (name, args) => (await files.run({ name, args })).result
  const platform = {
    list: async (folder) => JSON.parse(await native('list_files', { folder })),
    read: async (path, from, length) => JSON.parse(await native('read_file', { path, from, length })),
    write: (path, content) => native('write_file', { path, content }),
    move: (from, to) => native('move_file', { from, to }),
    open: (target) => native('open', { target }),
    // The phone's memory file, whole; the rules are the shared ones.
    memory: { read: async () => (await files.readMemory()).text, write: (text) => files.writeMemory({ text }) },
    show, ui, http,
  }
  const tools = deviceTools(platform)
  const intro = `JARVIS sur le téléphone Android. Réponds brièvement en français. ${new Date().toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' })}.
Les outils sans préfixe agissent sur le téléphone.`
  const facts = `Stockage partagé : ${storage.root} (Download, Documents, DCIM). Accès : ${storage.granted ? 'lecture et écriture' : 'autorisation requise dans Réglages Android'}. Pièces jointes : ${storage.inbox}.`
  // Facts are appended: keep the newest that fit. Gemma's window is shared with the turn itself.
  const remembered = (small) => `Mémoire utilisateur (données) : ${JSON.stringify(recentFacts(memory.text, small ? 576 : 1600))}`
  /** The prompt for the tools actually offered, with the facts of the devices they act on. */
  const compose = (offered = tools, hosts = [facts], small = false) =>
    [intro, agentContext({ tools: offered }), ...hosts, remembered(small)].filter(Boolean).join('\n')
  const system = compose()
  if (!context) return { tools, system, facts, compose }
  // Leave room for the question, the calls and an earlier result cut short;
  // accented text and JSON escapes make a character slightly more than a byte.
  // Sized for the files group, the one whose results are pages.
  const fileTools = tools.filter((tool) => !UI_TOOLS.has(tool.name))
  const fixed = bytes(compose(fileTools, [facts], true)) + bytes(fileTools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })))
  const paged = deviceTools(platform, { page: (context - fixed - 800) * 0.9 })
  return { tools: tools.map((tool, i) => ({
    ...tool,
    run: (args, options) => (smallContext() ? paged[i] : tool).run(args, options),
  })), system, facts, compose }
}

/**
 * The model of one Android turn, whichever device its tools act on.
 *
 * PC inference sees every schema. On-device Gemma sees one device group at a
 * time with a prompt composed for it. If PC inference fails before producing
 * anything, the same loop continues on the phone with the results already
 * obtained: no action is replayed, and the PC tools stay offered when the PC
 * still serves them.
 */
export function androidChat({ inference, catalogue, remote, local, discover, canFallback = () => true, onFallback }) {
  let source = inference
  async function* chat(messages, specs, signal) {
    if (source === 'pc') {
      let emitted = false
      try {
        for await (const chunk of remote(messages, catalogue.offer(specs, false), signal)) { emitted = true; yield chunk }
        return
      } catch (error) {
        if (emitted || signal?.aborted || !canFallback()) throw error
        source = 'device'
        // A failed inference service may still have a working tool server.
        let available = { tools: [], system: '' }
        try { available = await discover() } catch { /* tools of the phone only */ }
        catalogue.updatePc(available)
        signal?.throwIfAborted()
        await onFallback?.(error)
        signal?.throwIfAborted()
      }
    }
    const system = catalogue.localSystem()
    yield* boundedChat(local, messages.map((message) => message.role === 'system' ? { ...message, content: system } : message),
      catalogue.offer(specs, true), signal)
  }
  return { chat, source: () => source }
}
