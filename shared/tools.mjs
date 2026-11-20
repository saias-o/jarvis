/**
 * The one tool catalogue of the JARVIS device agent.
 *
 * The phone and the PC offer their model the same tools from this same code:
 * names, schemas, paging, what goes on screen and the web all live here. A
 * device contributes only the primitives that cannot be shared — reaching its
 * own disk under its own permissions, its memory file, its screen, its network
 * stack — and a capability it does not hand over is simply not offered.
 *
 * Browser-safe: the phone runs this inside its WebView.
 *
 * @typedef {object} Platform
 * @property {(folder: string) => Promise<{ name: string, dir: boolean, size: number }[]>} list
 * @property {(path: string, from: number, length: number) => Promise<{ text: string, total: number }>} read
 *   A slice of a text file and the length of the whole, in characters.
 * @property {{ read(): Promise<string> | string, write(text: string): unknown }} memory
 *   The device's memory file, whole. Its rules are shared/memory.mjs.
 * @property {(path: string, content: string) => Promise<unknown>} [write]
 * @property {(from: string, to: string, options?: { signal?: AbortSignal }) => Promise<unknown>} [move]  Must never replace a destination.
 * @property {(target: string) => Promise<unknown>} [open]
 * @property {(blade: object) => unknown} [show]  Puts a blade on the interface.
 * @property {(op: string, args: object) => unknown} [ui]  Hands an operation to the interface; see ui-tools.mjs.
 * @property {boolean} [camera]  Whether a blade may open the live camera view here.
 * @property {(request: object) => Promise<{ data?: string, mimeType?: string, error?: string }>} [capture]
 *   A frame from the camera, for models that can see images; see camera-tools.mjs.
 * @property {(op: object) => Promise<string>} [music]
 *   The player in the interface; see music-tools.mjs.
 * @property {Function} [http]  Transport for the web tools; see web-tools.mjs.
 * @property {(command: string, options: { signal?: AbortSignal }) => Promise<string>} [shell]
 */

import { webProbe, webTools, youtubeSearch } from './web-tools.mjs'
import { validatedTool } from './tool-validation.mjs'
import { memoryStore } from './memory.mjs'
import { uiTools } from './ui-tools.mjs'
import { displayTools } from './display-tools.mjs'
import { cameraTools } from './camera-tools.mjs'
import { musicTools } from './music-tools.mjs'

const DOCUMENTS = new Set([
  'pdf', 'doc', 'docx', 'odt', 'ods', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf',
  'csv', 'json', 'xml', 'html', 'htm', 'epub',
])

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const offset = (from) => Math.max(0, Math.floor(Number(from) || 0))
const string = { type: 'string' }
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required })

/**
 * @param {Platform} platform
 * @param {{ page?: number }} [options]  Characters one result may occupy in the
 *   model's context: a small on-device model reads pages, a large one chapters.
 */
export function deviceTools(platform, { page = 5000 } = {}) {
  page = Math.max(600, Math.min(5500, Math.floor(page) || 5000))
  const tools = [
    {
      name: 'list_files',
      description: 'List one page of a folder. contains filters by name; kind=documents keeps PDF, office and text files. Continue with the from offset returned.',
      parameters: schema({ folder: string, contains: string, kind: { type: 'string', enum: ['all', 'documents'] }, from: { type: 'number' } }, ['folder']),
      async run({ folder, contains, kind = 'all', from }) {
        const needle = String(contains ?? '').trim().toLowerCase()
        const entries = (await platform.list(folder))
          .map((entry) => ({ ...entry, key: entry.name.toLowerCase() }))
          .filter(({ key, dir }) => (!needle || key.includes(needle)) &&
            (kind === 'all' || (!dir && DOCUMENTS.has(key.slice(key.lastIndexOf('.') + 1)))))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        const start = Math.min(offset(from), entries.length)
        let out = ''
        let shown = 0
        for (const { name, dir, size } of entries.slice(start, start + 200)) {
          const line = dir ? `${name}/\n` : `${name} (${size} bytes)\n`
          if (shown && out.length + line.length > page - 80) break
          out += line
          shown++
        }
        const next = start + shown
        return out + (next < entries.length
          ? `[${entries.length - next} more entries; continue with from=${next}]`
          : `[End of folder: ${entries.length} entries total]`)
      },
    },
    {
      name: 'read_file',
      description: 'Read a text file, continuing from character offset from.',
      parameters: schema({ path: string, from: { type: 'number' } }, ['path']),
      async run({ path, from }) {
        const start = offset(from)
        const { text, total } = await platform.read(path, start, page)
        const end = start + text.length
        return end < total
          ? `${text}\n[${total - end} more characters; read on with from=${end}]`
          : text || '[the file is empty]'
      },
    },
  ]

  if (platform.write) {
    tools.push({
      name: 'write_file',
      description: 'Create or replace a text file.',
      parameters: schema({ path: string, content: string }),
      run: async ({ path, content }) => (await platform.write(path, content)) ?? 'Written.',
    })
  }
  if (platform.move) {
    tools.push({
      name: 'move_file',
      description: 'Move or rename a file; to is the full new path. Never replaces a destination.',
      parameters: schema({ from: string, to: string }),
      run: async ({ from, to }, options) => (await platform.move(from, to, options)) ?? 'Moved.',
    })
  }
  if (platform.open) {
    tools.push({
      name: 'open',
      description: 'Open a file or a web address in its usual application.',
      parameters: schema({ target: string }),
      async run({ target }) {
        const asked = String(target ?? '').trim()
        if (!asked) throw new Error('nothing to open')
        return (await platform.open(asked)) ?? 'Opened.'
      },
    })
  }

  if (platform.memory) {
    const memory = memoryStore(platform.memory)
    tools.push(
      {
        name: 'remember',
        description: 'Remember one short fact about the user, never passwords or credentials.',
        parameters: schema({ fact: string }),
        run: ({ fact }) => memory.remember(fact),
      },
      {
        name: 'forget',
        description: 'Forget facts containing these words.',
        parameters: schema({ match: string }),
        run: ({ match }) => memory.forget(match),
      },
    )
  }

  if (platform.show) {
    tools.push({
      name: 'show',
      description: 'Show text (one item per line) or an image on screen instead of reading it aloud. image: a PC file path or an image web address.',
      parameters: schema({ title: string, text: string, image: string }, []),
      async run({ title, text, image }) {
        const blade = { id: crypto.randomUUID(), title: String(title ?? '').trim().slice(0, 60) || 'DISPLAY', hold: 'turn' }
        const source = String(image ?? '').trim()
        const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        if (!source && !lines.length) throw new Error('Give text or an image to show')
        // The interface resolves the image through the PC bridge itself.
        await platform.show(source
          ? { ...blade, kind: 'image', url: source, size: 'full' }
          : { ...blade, kind: 'markup', html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(''), size: 'compact' })
        return 'On screen.'
      },
    })
  }

  // The richer screen tools draw on the same primitive as show.
  if (platform.show) {
    tools.push(...displayTools({ show: platform.show, camera: platform.camera,
      probe: platform.http && ((url, options) => webProbe(platform.http, url, options)) }))
  }
  if (platform.ui) tools.push(...uiTools(platform.ui))
  if (platform.capture) tools.push(...cameraTools(platform.capture))
  // A device with a player can be asked for music. Searching for it by name
  // needs the web as well, and without that the tool says so rather than
  // pretending the words were an address.
  if (platform.music) {
    tools.push(...musicTools(platform.music, {
      search: platform.http && ((query, options) => youtubeSearch(platform.http, query, options)),
    }))
  }

  if (platform.http) tools.push(...webTools(platform.http, { limit: page }))

  if (platform.shell) {
    tools.push({
      name: 'run_command',
      description: 'Run one shell command on this computer and get its output. Only when no other tool does the job.',
      parameters: schema({ command: string }),
      run: ({ command }, { signal } = {}) => platform.shell(String(command ?? ''), { signal }),
    })
  }

  // Forgiving tools (screen, interface) normalise their own arguments.
  return tools.map((tool) => (tool.forgiving ? tool : validatedTool(tool)))
}
