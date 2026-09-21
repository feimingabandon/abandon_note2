import assert from 'node:assert/strict'
import { app, nativeImage } from 'electron'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { getImageDimensions, getImageThumbnail } from '../src/main/db/db-images.js'

app.setPath('userData', mkdtempSync(join(tmpdir(), 'abandon-thumbnail-bench-')))
app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  try {
    const folder = join(app.getPath('userData'), 'attachments')
    mkdirSync(folder)
    const pixels = Buffer.alloc(1600 * 1200 * 4, 130)
    const png = nativeImage.createFromBitmap(pixels, { width: 1600, height: 1200 }).toPNG()
    writeFileSync(join(folder, 'fixture.png'), png)
    assert.deepEqual(getImageDimensions('attachments/fixture.png'), { width: 1600, height: 1200 })
    const start = performance.now()
    for (let i = 0; i < 100; i++) await getImageThumbnail('attachments/fixture.png', 240)
    const result = {
      repeatedDecodes: 100,
      width: 1600,
      height: 1200,
      elapsedMs: Math.round(performance.now() - start)
    }
    const initial = await getImageThumbnail('attachments/fixture.png', 240)
    const concurrent = getImageThumbnail('attachments/fixture.png', 128)
    assert.equal(concurrent, getImageThumbnail('attachments/fixture.png', 128))
    await concurrent
    pixels.fill(200)
    writeFileSync(
      join(folder, 'fixture.png'),
      nativeImage.createFromBitmap(pixels, { width: 1600, height: 1200 }).toPNG()
    )
    assert.notEqual(await getImageThumbnail('attachments/fixture.png', 240), initial)
    unlinkSync(join(folder, 'fixture.png'))
    assert.equal(await getImageThumbnail('attachments/fixture.png', 240), null)
    result.cacheInvalidation = 'passed'
    result.concurrentDeduplication = 'passed'
    writeFileSync(
      resolve(process.argv[2] || 'tmp/thumbnail-benchmark.json'),
      JSON.stringify(result, null, 2)
    )
    app.exit(0)
  } catch (error) {
    writeFileSync(resolve('tmp/thumbnail-benchmark-error.txt'), error.stack)
    app.exit(1)
  }
})
