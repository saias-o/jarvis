import { createReadStream } from 'node:fs'
import { link, mkdir, open, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'

/** For volumes without hard links. Only a destination created by this call is removed on failure. */
export async function copyExclusive(source, target, mode, signal) {
  const output = await open(target, 'wx', mode)
  try {
    await pipeline(createReadStream(source), output.createWriteStream(), { signal })
  } catch (error) {
    await output.close()
    await unlink(target)
    throw error
  }
}

export async function moveFile(source, target, signal) {
  signal?.throwIfAborted()
  const info = await stat(source)
  if (!info.isFile()) throw new Error('only single files can be moved')
  await mkdir(dirname(target), { recursive: true })
  try {
    try {
      await link(source, target)
    } catch (error) {
      if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].includes(error.code)) throw error
      await copyExclusive(source, target, info.mode, signal)
    }
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('a file with that name is already there', { cause: error })
    throw error
  }
  await unlink(source)
}
