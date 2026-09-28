import { readdir, lstat, unlink } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'

// Crashpad 正在写入的 pending/new 文件不参与维护。只管理本应用完整、已静置的转储。
export async function maintainCrashDumps(directory, now = Date.now()) {
  if (!directory) return { files: [], unavailable: true }
  const root = resolve(directory)
  const dumps = []
  let removed = 0
  for (const folder of ['', 'reports', 'completed']) {
    const parent = join(root, folder)
    let names
    try {
      names = await readdir(parent)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const name of names) {
      if (!/^[\da-f-]{16,64}\.dmp$/i.test(name)) continue
      const path = join(parent, name)
      const info = await lstat(path).catch(() => null)
      if (!info?.isFile() || info.isSymbolicLink()) continue
      dumps.push({
        name,
        path,
        relativePath: relative(root, path),
        size: info.size,
        mtimeMs: info.mtimeMs,
        modifiedAt: info.mtime.toISOString(),
        active: now - info.mtimeMs < 600000
      })
    }
  }
  dumps.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let count = 0
  let bytes = 0
  const retained = []
  for (const dump of dumps) {
    count++
    bytes += dump.size
    if (
      !dump.active &&
      (count > 3 || bytes > 100 * 1024 * 1024 || now - dump.mtimeMs > 7 * 86400000)
    ) {
      await unlink(dump.path)
      removed++
      count--
      bytes -= dump.size
    } else {
      const entry = { ...dump }
      delete entry.path
      delete entry.mtimeMs
      retained.push(entry)
    }
  }
  return {
    files: retained.slice(0, 16),
    omitted: Math.max(0, retained.length - 16),
    removed,
    bytes,
    activeExcluded: retained.filter((dump) => dump.active).length
  }
}
