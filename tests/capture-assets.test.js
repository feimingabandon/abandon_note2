import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { CaptureAssetStore } from '../src/main/capture/CaptureAssetStore.js'

describe('capture asset ownership', () => {
  it('rejects foreign IDs and oversized decoded headers before decode and cleans only owned sessions', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'capture-assets-test-'))
    const decode = vi.fn(async (bytes) => ({ width: 20, height: 30, size: bytes.length }))
    const store = new CaptureAssetStore(root, decode)
    try {
      const id = await store.create(),
        asset = randomUUID()
      await expect(store.read(id, '../foreign')).rejects.toThrow('失效')
      const png = Buffer.alloc(24)
      Buffer.from('89504e470d0a1a0a', 'hex').copy(png)
      png.writeUInt32BE(100000, 16)
      png.writeUInt32BE(100000, 20)
      await fs.writeFile(join(root, id, `${asset}.png`), png)
      await expect(store.read(id, asset)).rejects.toThrow('尺寸超限')
      expect(decode).not.toHaveBeenCalled()
      png.writeUInt32BE(20, 16)
      png.writeUInt32BE(30, 20)
      await fs.writeFile(join(root, id, `${asset}.png`), png)
      expect(await store.read(id, asset)).toMatchObject({ width: 20, height: 30, size: 24 })
      await store.release(id)
      await expect(fs.stat(join(root, id))).rejects.toThrow()
      await store.release(id)
    } finally {
      await store.dispose()
    }
  })
})
