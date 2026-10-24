import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Scope fault injection to owned files and the handles actually opened for them. */
export function createOwnedDraftAssetIo({
  filesystem,
  assetRoot,
  metrics,
  beforeWrite,
  denyUnlink
}) {
  const original = Object.fromEntries(
    ['open', 'writeFile', 'readFile', 'unlink'].map((key) => [key, filesystem[key]])
  )
  const handles = new WeakSet()
  function ownedAsset(path) {
    if (typeof path !== 'string') return false
    const suffix = relative(assetRoot, resolve(path))
    return Boolean(
      suffix &&
      suffix !== '..' &&
      !suffix.startsWith('..' + sep) &&
      !isAbsolute(suffix) &&
      /^[a-f0-9-]{36}\.asset$/.test(suffix)
    )
  }
  const io = {
    async open(path, flags, ...args) {
      const handle = await original.open(path, flags, ...args)
      if (flags === 'wx' && ownedAsset(path)) handles.add(handle)
      if (flags === 'r' && ownedAsset(path)) {
        const read = handle.read.bind(handle)
        let counted = false
        handle.read = (...readArgs) => {
          // Ownership headers are not image payload reads. Count one actual
          // payload access per fixed handle, regardless of its chunk count.
          if (!counted && typeof readArgs[3] === 'number' && readArgs[3] >= 512) {
            counted = true
            metrics.reads++
          }
          return read(...readArgs)
        }
      }
      return handle
    },
    async writeFile(target, ...args) {
      if (ownedAsset(target) || (typeof target === 'object' && target && handles.has(target))) {
        metrics.writes++
        await beforeWrite?.()
      }
      return original.writeFile(target, ...args)
    },
    async readFile(path, ...args) {
      if (ownedAsset(path)) metrics.reads++
      return original.readFile(path, ...args)
    },
    async unlink(path, ...args) {
      if (ownedAsset(path) && denyUnlink?.()) {
        metrics.deniedUnlinks++
        throw Object.assign(new Error('Controlled owned draft unlink denial'), { code: 'EACCES' })
      }
      return original.unlink(path, ...args)
    }
  }
  return { io, original }
}
