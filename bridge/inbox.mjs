/**
 * The inbox: where a file handed to JARVIS lands.
 *
 * Dropping a file on the interface (or picking one on a phone) uploads it to
 * the bridge, which stores it here and tells the agent where it is. The inbox
 * sits inside the agent's workspace, so the file tools already reach it —
 * reading a dropped file needs no new permission, and moving it somewhere else
 * is an ordinary write under the ordinary rules.
 *
 * Two things are decided here and nowhere else: what a file may be called once
 * it is on disk, and which paths count as "something the user dropped". The
 * second matters because the question that follows names its files, and a page
 * must not be able to point the agent at an arbitrary path by claiming it was
 * dropped.
 */

import { createWriteStream } from 'node:fs'
import { mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'

const MAX_NAME = 120

/** Names Windows will not create, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/**
 * What an uploaded file is called on disk.
 *
 * The name comes from another device and is used as a path component, so it is
 * reduced to one: no directories, nothing a filesystem refuses, no trailing
 * dot or space (Windows drops them and the file is then unreachable by the
 * name it was given), and never empty.
 */
export function safeName(raw) {
  let name = String(raw ?? '')
    .normalize('NFC')
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/[. ]+$/, '')
    .trim()
  // A leading dot would make it a hidden file, and `.env` a refused one.
  name = name.replace(/^\.+/, '')
  if (!name) name = 'file'
  const ext = extname(name).slice(0, 16)
  let stem = ext ? name.slice(0, -ext.length) : name
  if (RESERVED.test(stem)) stem = `_${stem}`
  return stem.slice(0, MAX_NAME - ext.length) + ext
}

const pad = (n) => String(n).padStart(2, '0')

/** Images a multimodal local model can be shown directly. */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

const human = (bytes) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * @param {string} dir               The inbox folder; created on first use.
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]   Largest upload accepted.
 */
export function createInbox(dir, { maxBytes = 1024 * 1024 * 1024 } = {}) {
  const root = resolve(dir)

  /** A free name in `folder`: `report.pdf`, then `report (2).pdf`, … */
  async function freeName(folder, name) {
    const ext = extname(name)
    const stem = ext ? name.slice(0, -ext.length) : name
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`
      try {
        await stat(join(folder, candidate))
      } catch {
        return candidate
      }
    }
    return `${stem}-${randomBytes(4).toString('hex')}${ext}`
  }

  /**
   * Write one request body to the inbox. Streamed, so a large file never sits
   * in this process's memory — the same process is carrying the voice.
   * Rejects with `.status` set when the upload should be refused.
   */
  async function receive(req, rawName) {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw Object.assign(new Error('too large'), { status: 413 })
    }
    const now = new Date()
    // A folder per day, so the inbox stays something a person can look through.
    const folder = join(root, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
    await mkdir(folder, { recursive: true })

    const part = join(folder, `.${randomBytes(8).toString('hex')}.part`)
    const out = createWriteStream(part, { flags: 'wx', mode: 0o600 })
    let size = 0
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > maxBytes) throw Object.assign(new Error('too large'), { status: 413 })
        if (!out.write(chunk)) await once(out, 'drain')
      }
      out.end()
      await finished(out)
      if (size === 0) throw Object.assign(new Error('empty file'), { status: 400 })
      const name = await freeName(folder, safeName(rawName))
      const path = join(folder, name)
      await rename(part, path)
      return { path, name, size }
    } catch (err) {
      out.destroy()
      await rm(part, { force: true })
      throw err
    }
  }

  /** The real path of `path` if it is a file inside the inbox, else null. */
  async function owned(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) return null
    try {
      const real = await realpath(path)
      const base = await realpath(root)
      const rel = relative(base, real)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
      return (await stat(real)).isFile() ? real : null
    } catch {
      return null
    }
  }

  /**
   * What the agent is told about the files that came with a question.
   *
   * Written by the bridge from paths it has checked, never passed through from
   * the page, and marked as machine text so it is not read aloud or mistaken
   * for something the user said. Resolves `{ note, images }`: the lines to put
   * before the question, and the pictures among the files.
   */
  async function describe(paths) {
    const lines = []
    const images = []
    for (const asked of Array.isArray(paths) ? paths.slice(0, 12) : []) {
      const real = await owned(asked)
      if (!real) continue
      const info = await stat(real)
      lines.push(`[Dropped file: ${real} | ${human(info.size)}]`)
      if (IMAGE_EXT.has(extname(real).toLowerCase())) images.push(real)
    }
    return { note: lines.length ? `${lines.join('\n')}\n` : '', images }
  }

  return { dir: root, maxBytes, receive, owned, describe }
}
