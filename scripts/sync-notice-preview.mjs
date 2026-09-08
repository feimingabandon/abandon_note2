import { createHash } from 'node:crypto'
import { cp, readFile, readdir, mkdir, rm } from 'node:fs/promises'
import { resolve, join, relative, sep } from 'node:path'

// Explicit target only: this command updates a second repository's generated
// public preview, and never touches its source, credentials, or user media.
const serverRoot = process.argv[2]
if (!serverRoot) throw new Error('Usage: node scripts/sync-notice-preview.mjs <server-repository>')
const source = resolve('tmp/notice-preview-dist')
const target = resolve(serverRoot, 'web/public/notice-preview')
const manifest = JSON.parse(await readFile(join(source, 'source-manifest.json'), 'utf8'))
for (const [path, expected] of Object.entries(manifest.files)) {
  const hash = createHash('sha256')
    .update(await readFile(resolve(path)))
    .digest('hex')
  if (hash !== expected) throw new Error(`Preview is stale; rebuild first: ${path}`)
}
await readFile(resolve(serverRoot, 'web/package.json'))
await mkdir(target, { recursive: true })
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Preview directories must not contain symlinks')
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await files(path)))
    else result.push(path)
  }
  return result
}
const incoming = new Set((await files(source)).map((path) => relative(source, path)))
for (const path of await files(target)) {
  const resolved = resolve(path)
  if (!resolved.startsWith(target + sep)) throw new Error('Preview target escaped destination')
  if (!incoming.has(relative(target, path))) await rm(resolved) // Obsolete generated files only; no recursive delete.
}
await cp(source, target, { recursive: true })
console.log(`Synchronized ${incoming.size} generated preview files to ${target}`)
