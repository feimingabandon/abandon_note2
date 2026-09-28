import { mkdtemp, readFile, writeFile, rm, utimes, mkdir, rename, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogStore, encodeLogRecord } from '../src/main/logging/log-store.mjs'
import { maintainCrashDumps } from '../src/main/logging/crash-dump-store.mjs'

const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(options) {
  const root = await mkdtemp(join(tmpdir(), 'abandon-log-store-'))
  roots.push(root)
  const directory = join(root, 'logs')
  return { root, directory, store: createLogStore(directory, options) }
}
const record = (id, extra = {}) => ({
  schemaVersion: 3,
  id: `r-${id}`,
  time: new Date().toISOString(),
  scope: 'test',
  level: 'info',
  message: `记录-${id}-🙂`,
  ...extra
})

describe('worker log file storage', () => {
  it('orders both pools and delayed replay by event time with stable, gap-free pages', async () => {
    const { store } = await fixture()
    const at = (minute) => new Date(Date.UTC(2026, 8, 28, 8, minute)).toISOString()
    await store.append([record('app-old', { time: at(1) })])
    await store.append([record('detail-middle', { storage: 'detail', time: at(2) })])
    await store.append([record('app-new', { time: at(3) })])
    await store.append([record('replayed-old', { storage: 'detail', time: at(0) })])
    const first = await store.query({ limit: 2 })
    expect(first.items.map((item) => item.id)).toEqual(['r-app-new', 'r-detail-middle'])
    await store.append([record('outside-snapshot', { time: at(4) })])
    const second = await store.query({ limit: 2, cursor: first.nextCursor })
    expect(second.items.map((item) => item.id)).toEqual(['r-app-old', 'r-replayed-old'])
    expect(second.hasMore).toBe(false)
    store.close()
  })
  it('bounds page bytes while preserving Unicode offsets and equal-time cursor ties', async () => {
    const { store, directory } = await fixture()
    await store.maintain()
    const time = new Date().toISOString()
    const records = Array.from({ length: 9 }, (_, i) =>
      record(i, { time, message: '字🙂'.repeat(30000) })
    )
    await writeFile(join(directory, 'app-2026-09-28.jsonl'), records.map(JSON.stringify).join('\n'))
    const ids = []
    let cursor
    do {
      const page = await store.query({ cursor })
      expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThan(1024 * 1024)
      expect(page.items.every((item) => item.message === records[0].message)).toBe(true)
      ids.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(ids).toEqual(records.map((item) => item.id).reverse())
    store.close()
  })
  it('invalidates a pinned export under space pressure without dropping new writes', async () => {
    const { store, root } = await fixture({ maxFileBytes: 512, dailyBytes: 1024 })
    for (const id of ['one', 'two']) await store.append([record(id, { message: 'x'.repeat(250) })])
    const frozen = await store.freezeExport()
    await expect(
      store.append([record('live', { message: 'x'.repeat(250) })])
    ).resolves.toMatchObject({
      records: 1,
      errors: 0
    })
    const output = join(root, 'preserved-export.jsonl')
    await writeFile(output, 'existing export')
    await expect(store.exportTo(output, {}, null, { snapshotId: frozen.id })).rejects.toThrow(
      '空间不足'
    )
    expect(await readFile(output, 'utf8')).toBe('existing export')
    expect((await store.files()).reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(
      1024
    )
    expect((await store.query()).items.some((item) => item.id === 'r-live')).toBe(true)
    expect(store.stats().writeErrors).toBe(0)
    store.close()
  })
  it('pins the export byte offsets before a save dialog and excludes subsequent appends', async () => {
    const { store, root } = await fixture()
    await store.append([record('before-dialog')])
    const frozen = await store.freezeExport()
    await store.append([record('while-choosing-target')])
    const output = join(root, 'frozen-export.jsonl')
    await store.exportTo(output, {}, null, { snapshotId: frozen.id })
    const content = await readFile(output, 'utf8')
    expect(content).toContain('r-before-dialog')
    expect(content).not.toContain('r-while-choosing-target')
    store.close()
  })
  it('aborts an active export and removes partial output while allowing retention writes', async () => {
    const { store, root } = await fixture({ maxFileBytes: 256 * 1024, dailyBytes: 512 * 1024 })
    const batch = (prefix) =>
      Array.from({ length: 500 }, (_, i) => record(`${prefix}-${i}`, { message: 'x'.repeat(512) }))
    await store.append(batch('old'))
    const frozen = await store.freezeExport()
    const output = join(root, 'active-export.jsonl')
    await writeFile(output, 'previous export')
    let started
    const opening = new Promise((resolve) => {
      started = resolve
    })
    const exporting = store
      .exportTo(
        output,
        {
          toJSON() {
            started()
            return {}
          }
        },
        null,
        { snapshotId: frozen.id }
      )
      .then(
        () => null,
        (error) => error
      )
    await opening
    await expect(store.append(batch('new'))).resolves.toMatchObject({ records: 500 })
    expect((await exporting)?.message).toContain('空间不足')
    expect(await readFile(output, 'utf8')).toBe('previous export')
    expect((await readdir(root)).some((file) => file.includes('.partial-'))).toBe(false)
    expect((await store.files()).reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(
      512 * 1024
    )
    expect(store.stats().writeErrors).toBe(0)
    store.close()
  })
  it('separates an interrupted legacy tail from subsequent complete records', async () => {
    const { store, directory } = await fixture()
    await store.append([record('first')])
    const [file] = await store.files()
    store.close()
    await writeFile(file.path, '{partial')
    const recovered = createLogStore(directory)
    await recovered.append([record('after-recovery')])
    const result = await recovered.query()
    expect(result.items.map((item) => item.id)).toEqual(['r-after-recovery'])
    expect(recovered.stats().parseErrors).toBeGreaterThan(0)
    recovered.close()
  })
  it('round-trips Unicode across read chunks, keeps stable pages and bounds new encoded records', async () => {
    const { store } = await fixture()
    await store.append(Array.from({ length: 700 }, (_, i) => record(i)))
    const first = await store.query({ limit: 199 })
    expect(first.items[0].id).toBe('r-699')
    await store.append([record('new')])
    const second = await store.query({ limit: 200, cursor: first.nextCursor })
    expect(second.items[0].id).toBe('r-500')
    expect(second.items.at(-1).id).toBe('r-301')
    expect(second.items.every((item) => item.message.endsWith('🙂'))).toBe(true)
    expect(
      Buffer.byteLength(encodeLogRecord(record(1, { message: '\0'.repeat(100000) })))
    ).toBeLessThanOrEqual(8192)
    store.close()
  })
  it('rotates and enforces independent daily/detail quotas on write without deleting foreign files', async () => {
    const { store, directory } = await fixture({
      maxFileBytes: 1024,
      dailyBytes: 2048,
      detailBytes: 2048
    })
    await store.maintain()
    await writeFile(join(directory, 'user-file.txt'), 'keep')
    for (let i = 0; i < 40; i++)
      await store.append([
        record(i, { message: 'x'.repeat(150), storage: i % 2 ? 'detail' : 'app' })
      ])
    const files = await store.files()
    for (const pool of ['app', 'detail'])
      expect(
        files.filter((f) => f.pool === pool).reduce((sum, f) => sum + f.size, 0)
      ).toBeLessThanOrEqual(2048)
    expect(files.every((f) => f.size <= 1024)).toBe(true)
    expect(await readFile(join(directory, 'user-file.txt'), 'utf8')).toBe('keep')
    expect(store.stats().removedFiles).toBeGreaterThan(0)
    store.close()
  })
  it('reads legacy JSONL and reports corrupt tails, duplicates and missing window evidence', async () => {
    const { store, directory, root } = await fixture()
    await store.maintain()
    const legacy = record('old', { schemaVersion: 2 })
    await writeFile(
      join(directory, 'app-2026-09-28.jsonl'),
      `${JSON.stringify(legacy)}\n${JSON.stringify(legacy)}\n{bad-tail`
    )
    const queried = await store.query()
    expect(queried.items).toHaveLength(1)
    const output = join(root, 'export.jsonl')
    await store.exportTo(output, { type: 'diagnostic-export' }, { fixture: true }, null, {
      capture: { complete: false }
    })
    const lines = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse)
    expect(lines.at(-2)).toMatchObject({
      type: 'diagnostic-complete',
      complete: false,
      exportFinished: true,
      manifest: { parseErrors: 1, duplicateRecords: 1 }
    })
    expect(lines.at(-1)).toMatchObject({ type: 'diagnostic-system', snapshot: { fixture: true } })
    await expect(
      store.exportTo(join(directory, 'app-2026-09-28.jsonl'), {}, null, null)
    ).rejects.toThrow('不能覆盖')
    store.close()
  })
  it('includes explicit cutoff summaries but excludes ordinary records after the export cutoff', async () => {
    const { store, root } = await fixture()
    const cutoff = Date.now() - 10000
    await store.append([
      record('before', { time: new Date(cutoff - 1).toISOString() }),
      record('after'),
      record('summary', { exportRequestId: 'freeze' })
    ])
    const output = join(root, 'cutoff.jsonl')
    await store.exportTo(output, {}, null, { to: cutoff, requestId: 'freeze' })
    const text = await readFile(output, 'utf8')
    expect(text).toContain('r-before')
    expect(text).toContain('r-summary')
    expect(text).not.toContain('r-after')
    store.close()
  })
  it('surfaces unwritable storage and recovers without modifying the blocking file', async () => {
    const { root } = await fixture()
    const blocked = join(root, 'blocked')
    await writeFile(blocked, 'keep')
    const store = createLogStore(blocked)
    await expect(store.append([record('lost')])).rejects.toThrow()
    expect(await readFile(blocked, 'utf8')).toBe('keep')
    await rename(blocked, join(root, 'original-blocker'))
    await expect(store.append([record('recovered')])).resolves.toMatchObject({ records: 1 })
    expect((await store.query()).items.map((item) => item.id)).toEqual(['r-recovered'])
    expect(await readFile(join(root, 'original-blocker'), 'utf8')).toBe('keep')
    store.close()
  })
  it('maintains only complete stale application dumps, preserving active and pending files', async () => {
    const { root } = await fixture()
    const directory = join(root, 'crashes')
    await mkdir(join(directory, 'completed'), { recursive: true })
    await mkdir(join(directory, 'pending'))
    const now = Date.now()
    for (let i = 0; i < 6; i++) {
      const file = join(directory, 'completed', `${String(i).padStart(32, 'a')}.dmp`)
      await writeFile(file, 'dump')
      await utimes(file, new Date(now - (i + 1) * 3600000), new Date(now - (i + 1) * 3600000))
    }
    const pending = join(directory, 'pending', `${'b'.repeat(32)}.dmp`)
    await writeFile(pending, 'pending')
    const active = join(directory, 'completed', `${'c'.repeat(32)}.dmp`)
    await writeFile(active, 'active')
    const result = await maintainCrashDumps(directory, now)
    expect(result.files).toHaveLength(3)
    expect(result.removed).toBe(4)
    expect(await readFile(pending, 'utf8')).toBe('pending')
    expect(await readFile(active, 'utf8')).toBe('active')
  })
})
