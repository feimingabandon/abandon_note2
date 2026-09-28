// 只在日志 Worker 中使用；文件 IO、JSON 编码/解析均不占应用主线程。
import { mkdir, readdir, stat, appendFile, open, unlink, rename } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setImmediate as yieldIO } from 'node:timers/promises'
import { diagnosticRecordLimit } from '../../shared/diagnostic-policy.js'
import { diagnosticText, sanitizeDiagnosticValue } from '../../shared/diagnostic-sanitize.js'

const FILE_PATTERN = /^(app|detail)-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/
const MiB = 1024 * 1024
const DAY = 86400_000
const dateKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const pathKey = (path) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

export function encodeLogRecord(record) {
  const limit = diagnosticRecordLimit(record)
  let line = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(line) <= limit) return line
  const bounded = {
    ...record,
    message: diagnosticText(record.message, 512),
    error: sanitizeDiagnosticValue(record.error, { maxBytes: Math.floor(limit / 2) }),
    metadata: { truncated: true, reason: 'record-byte-limit' },
    truncation: { originalBytes: Buffer.byteLength(line), previewTruncated: true }
  }
  line = `${JSON.stringify(bounded)}\n`
  if (Buffer.byteLength(line) <= limit) return line
  return `${JSON.stringify({
    schemaVersion: 3,
    id: String(record.id).slice(0, 160),
    time: record.time,
    level: record.level,
    scope: String(record.scope).slice(0, 96),
    sessionId: record.sessionId,
    actionId: record.actionId,
    truncation: { previewTruncated: true, reason: 'record-byte-limit' }
  })}\n`
}

export function createLogStore(directory, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? 5 * MiB
  const poolLimits = {
    app: options.dailyBytes ?? 30 * MiB,
    detail: options.detailBytes ?? 20 * MiB
  }
  const retention = { app: 14 * DAY, detail: 7 * DAY }
  const active = new Map()
  const snapshots = new Map()
  const pins = new Map()
  let exportActive = false
  const stats = {
    writtenRecords: 0,
    writtenBytes: 0,
    writeErrors: 0,
    removedFiles: 0,
    parseErrors: 0,
    truncatedLines: 0
  }
  async function files() {
    // 不缓存失败的初始化 Promise；磁盘或权限恢复后，下一次操作可以重试。
    await mkdir(directory, { recursive: true })
    const names = await readdir(directory)
    const result = []
    for (const name of names) {
      const match = FILE_PATTERN.exec(name)
      if (!match) continue
      try {
        const info = await stat(join(directory, name))
        if (info.isFile())
          result.push({
            name,
            path: join(directory, name),
            pool: match[1],
            size: info.size,
            mtimeMs: info.mtimeMs,
            modifiedAt: info.mtime.toISOString()
          })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    return result.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
  }

  function unpinSnapshot(snapshot) {
    if (snapshot.unpinned) return
    snapshot.unpinned = true
    for (const file of snapshot.files) {
      const count = (pins.get(file.name) || 1) - 1
      if (count) pins.set(file.name, count)
      else pins.delete(file.name)
    }
  }

  function releaseSnapshot(id) {
    const snapshot = snapshots.get(id)
    if (!snapshot) return
    unpinSnapshot(snapshot)
    snapshots.delete(id)
  }

  function assertSnapshot(snapshot) {
    if (snapshot.aborted) throw new Error(snapshot.aborted)
    if (!snapshots.has(snapshot.id)) throw new Error('日志快照已过期，请刷新')
  }

  function expireSnapshots() {
    for (const [id, snapshot] of snapshots) {
      if (snapshot.expiresAt < Date.now() && !snapshot.reading) releaseSnapshot(id)
    }
  }

  async function cleanup(pool, incoming = 0) {
    expireSnapshots()
    const list = (await files()).filter((file) => file.pool === pool).reverse()
    let total = list.reduce((sum, file) => sum + file.size, 0)
    for (const file of list) {
      if (total + incoming <= poolLimits[pool] && Date.now() - file.mtimeMs <= retention[pool])
        continue
      if (file.name === active.get(pool)?.name) continue
      if (pins.has(file.name)) {
        // 先使引用该文件的快照失效，再让出空间；保存对话框期间也必须生效。
        for (const [id, snapshot] of snapshots) {
          if (!snapshot.files.some((item) => item.name === file.name)) continue
          if (snapshot.exporting) {
            snapshot.aborted = '导出因日志空间不足而中止，请重新导出'
            unpinSnapshot(snapshot)
          } else releaseSnapshot(id)
        }
      }
      try {
        await unlink(file.path)
        total -= file.size
        stats.removedFiles++
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    if (total + incoming > poolLimits[pool])
      throw Object.assign(new Error('日志保留空间不足'), { code: 'LOG_STORAGE_BUDGET' })
  }

  async function selectFile(pool, bytes) {
    const date = dateKey()
    let file = active.get(pool)
    if (!file || file.date !== date) file = { date, part: 0, size: 0, name: '' }
    if (!file.name) {
      for (;;) {
        file.name = `${pool}-${date}${file.part ? `-${file.part}` : ''}.jsonl`
        try {
          file.size = (await stat(join(directory, file.name))).size
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          file.size = 0
        }
        if (file.size) {
          const handle = await open(join(directory, file.name), 'r')
          const tail = Buffer.alloc(1)
          try {
            await handle.read(tail, 0, 1, file.size - 1)
          } finally {
            await handle.close()
          }
          if (tail[0] !== 10) {
            // 中断写入后的残行独立保留，不能与下一条完整记录拼成一行。
            await appendFile(join(directory, file.name), '\n')
            file.size++
          }
        }
        if (!file.size || file.size + bytes <= maxFileBytes) break
        file.part++
      }
    }
    if (file.size && file.size + bytes > maxFileBytes) {
      file = { date, part: file.part + 1, size: 0, name: '' }
      active.set(pool, file)
      return selectFile(pool, bytes)
    }
    active.set(pool, file)
    return file
  }

  async function append(records) {
    // 恢复写入时重新检查目录；若被同名文件占用则显式失败。
    await mkdir(directory, { recursive: true })
    const started = performance.now()
    let bytes = 0
    let written = 0
    const groups = new Map()
    for (const record of records) {
      const pool = record.storage === 'detail' ? 'detail' : 'app'
      const line = encodeLogRecord(record)
      const list = groups.get(pool) || []
      list.push(line)
      groups.set(pool, list)
    }
    try {
      for (const [pool, lines] of groups) {
        let batch = ''
        async function writeBatch() {
          if (!batch) return
          const size = Buffer.byteLength(batch)
          const file = await selectFile(pool, size)
          await cleanup(pool, size)
          await appendFile(join(directory, file.name), batch, 'utf8')
          file.size += size
          bytes += size
          batch = ''
        }
        for (const line of lines) {
          if (
            batch &&
            Buffer.byteLength(batch) + Buffer.byteLength(line) > Math.min(maxFileBytes, 64 * 1024)
          )
            await writeBatch()
          batch += line
          written++
        }
        await writeBatch()
      }
      stats.writtenRecords += written
      stats.writtenBytes += bytes
      return {
        records: written,
        bytes,
        durationMs: performance.now() - started,
        errors: 0,
        droppedRecords: 0
      }
    } catch (error) {
      active.clear()
      stats.writeErrors++
      throw error
    }
  }

  async function snapshot(exporting = false) {
    expireSnapshots()
    if (snapshots.size >= 8) {
      const oldest = [...snapshots].find(([, item]) => !item.exporting || item.aborted)
      if (oldest) releaseSnapshot(oldest[0])
    }
    const id = randomUUID()
    const value = { id, files: await files(), expiresAt: Date.now() + 120_000, exporting }
    for (const file of value.files) pins.set(file.name, (pins.get(file.name) || 0) + 1)
    snapshots.set(id, value)
    return value
  }

  async function* lines(file, reverse = false, current = null, withOffsets = false) {
    if (current) assertSnapshot(current)
    let handle
    try {
      handle = await open(file.path, 'r')
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    try {
      // 单文件有大小上限；向前/向后均按 64 KiB 读，旧日志大行也有 1 MiB 容错上限。
      let offset = reverse ? file.size : 0
      let pending = Buffer.alloc(0)
      let skippingOversize = false
      while (reverse ? offset > 0 : offset < file.size) {
        if (current) assertSnapshot(current)
        const size = Math.min(64 * 1024, reverse ? offset : file.size - offset)
        const position = reverse ? offset - size : offset
        const buffer = Buffer.allocUnsafe(size)
        const { bytesRead } = await handle.read(buffer, 0, size, position)
        if (current) assertSnapshot(current)
        if (!bytesRead) break
        const chunk = buffer.subarray(0, bytesRead)
        const base = reverse ? position : position - pending.length
        offset = reverse ? position : position + bytesRead
        const combined = reverse ? Buffer.concat([chunk, pending]) : Buffer.concat([pending, chunk])
        const entry = (start, end) => {
          const line = combined.subarray(start, end).toString('utf8')
          return withOffsets ? { line, offset: base + start, length: end - start } : line
        }
        let boundary = reverse ? combined.length : 0
        if (reverse) {
          for (let i = combined.length - 1; i >= 0; i--)
            if (combined[i] === 10) {
              if (!skippingOversize && boundary > i + 1) yield entry(i + 1, boundary)
              skippingOversize = false
              boundary = i
            }
          pending = combined.subarray(0, boundary)
        } else {
          for (let i = 0; i < combined.length; i++)
            if (combined[i] === 10) {
              if (!skippingOversize && i > boundary) yield entry(boundary, i)
              skippingOversize = false
              boundary = i + 1
            }
          pending = combined.subarray(boundary)
        }
        if (pending.length > MiB) {
          pending = Buffer.alloc(0)
          skippingOversize = true
          stats.truncatedLines++
        }
        await yieldIO()
      }
      if (pending.length && !skippingOversize) {
        const line = pending.toString('utf8')
        yield withOffsets
          ? { line, offset: reverse ? 0 : offset - pending.length, length: pending.length }
          : line
      }
    } finally {
      await handle.close()
    }
  }

  const matches = (record, query) => {
    if (query.levels?.length && !query.levels.includes(record.level)) return false
    if (query.processes?.length && !query.processes.includes(record.process)) return false
    const search = String(query.search || '')
      .slice(0, 512)
      .toLocaleLowerCase()
    return !search || JSON.stringify(record).toLocaleLowerCase().includes(search)
  }

  async function query(query = {}) {
    expireSnapshots()
    let current
    let after = null
    // 时间相同按冻结文件序号、字节位置确定稳定顺序，不受后续 append 影响。
    const compare = (a, b) => b.time - a.time || a.file - b.file || b.offset - a.offset
    if (query.cursor) {
      try {
        const cursor = JSON.parse(
          Buffer.from(String(query.cursor).slice(0, 1024), 'base64url').toString()
        )
        current = snapshots.get(cursor.id)
        after = cursor.after
        if (
          !current ||
          !Number.isFinite(after?.time) ||
          !Number.isSafeInteger(after.file) ||
          after.file < 0 ||
          after.file >= current.files.length ||
          !Number.isSafeInteger(after.offset) ||
          after.offset < 0 ||
          after.offset >= current.files[after.file].size
        )
          throw new Error()
      } catch {
        throw new Error('日志快照已过期，请刷新')
      }
    } else current = await snapshot()
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 200))
    const candidates = []
    const seen = new Set()
    // 近期轨迹回放和跨进程延迟使单个文件也可能乱序，不能直接归并物理行。
    // 每页扫描固定快照，只保留最多 201 个偏移，避免把两个池的记录全部放进内存。
    for (let fileIndex = 0; fileIndex < current.files.length; fileIndex++) {
      const file = current.files[fileIndex]
      for await (const entry of lines(file, true, current, true)) {
        let record
        try {
          record = JSON.parse(entry.line)
        } catch {
          stats.parseErrors++
          continue
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          stats.parseErrors++
          continue
        }
        if (record.id && seen.has(record.id)) continue
        if (record.id && seen.size < 8192) seen.add(record.id)
        if (!matches(record, query)) continue
        const time = Date.parse(record.time)
        const candidate = {
          time: Number.isFinite(time) ? time : 0,
          file: fileIndex,
          offset: entry.offset,
          length: entry.length
        }
        if (after && compare(candidate, after) <= 0) continue
        let low = 0
        let high = candidates.length
        while (low < high) {
          const middle = (low + high) >>> 1
          if (compare(candidate, candidates[middle]) < 0) high = middle
          else low = middle + 1
        }
        if (low > limit) continue
        candidates.splice(low, 0, candidate)
        if (candidates.length > limit + 1) candidates.pop()
      }
    }
    const items = []
    const handles = new Map()
    let bytes = 0
    let last = null
    try {
      for (const candidate of candidates) {
        if (items.length >= limit || (items.length && bytes + candidate.length > MiB)) break
        assertSnapshot(current)
        if (!handles.has(candidate.file))
          handles.set(candidate.file, await open(current.files[candidate.file].path, 'r'))
        const buffer = Buffer.alloc(candidate.length)
        const { bytesRead } = await handles
          .get(candidate.file)
          .read(buffer, 0, buffer.length, candidate.offset)
        if (bytesRead !== candidate.length) throw new Error('日志快照文件发生变化，请刷新')
        items.push(JSON.parse(buffer.toString('utf8')))
        bytes += candidate.length
        last = candidate
      }
    } finally {
      await Promise.all([...handles.values()].map((handle) => handle.close()))
    }
    assertSnapshot(current)
    const hasMore = candidates.length > items.length
    const cursor = hasMore
      ? Buffer.from(
          JSON.stringify({
            id: current.id,
            after: { time: last.time, file: last.file, offset: last.offset }
          })
        ).toString('base64url')
      : null
    if (!hasMore) releaseSnapshot(current.id)
    return {
      items,
      hasMore,
      nextCursor: cursor,
      files: current.files.map(({ name, size, modifiedAt }) => ({ name, size, modifiedAt }))
    }
  }

  async function exportTo(targetPath, header, systemDiagnostics, selection, manifest = {}) {
    if (exportActive) throw new Error('已有日志正在导出')
    const target = resolve(targetPath)
    if (
      pathKey(join(directory, basename(target))) === pathKey(target) &&
      FILE_PATTERN.test(basename(target))
    )
      throw new Error('导出目标不能覆盖现有日志文件')
    exportActive = true
    let current
    let output
    const temporary = `${target}.partial-${randomUUID()}`
    const completeness = { records: 0, duplicateRecords: 0, parseErrors: 0, dedupeLimited: false }
    try {
      if (selection?.snapshotId) {
        expireSnapshots()
        current = snapshots.get(selection.snapshotId)
        if (!current || !current.exporting) throw new Error('导出快照已过期，请重新导出')
      } else current = await snapshot(true)
      assertSnapshot(current)
      current.reading = true
      if (current.files.some((file) => pathKey(file.path) === pathKey(target)))
        throw new Error('导出目标不能覆盖现有日志文件')
      output = await open(temporary, 'wx')
      await output.write(`${JSON.stringify(header)}\n`)
      const seen = new Set()
      for (const file of current.files.slice().reverse()) {
        for await (const line of lines(file, false, current)) {
          assertSnapshot(current)
          let record
          try {
            record = JSON.parse(line)
          } catch {
            completeness.parseErrors++
            continue
          }
          if (!record || typeof record !== 'object' || Array.isArray(record)) {
            completeness.parseErrors++
            continue
          }
          if (selection?.sessionId && record.sessionId !== selection.sessionId) continue
          const timestamp = Date.parse(record.time)
          const exportSnapshot =
            selection?.requestId && record.exportRequestId === selection.requestId
          if (
            selection?.from &&
            (!Number.isFinite(timestamp) || timestamp < selection.from) &&
            !exportSnapshot
          )
            continue
          if (
            selection?.to &&
            (!Number.isFinite(timestamp) || timestamp > selection.to) &&
            !exportSnapshot
          )
            continue
          if (record.id && seen.has(record.id)) {
            completeness.duplicateRecords++
            continue
          }
          if (record.id && seen.size < 8192) seen.add(record.id)
          else if (seen.size >= 8192) completeness.dedupeLimited = true
          await output.write(`${line}\n`)
          completeness.records++
        }
      }
      assertSnapshot(current)
      const complete =
        manifest.capture?.complete !== false &&
        !completeness.parseErrors &&
        !stats.truncatedLines &&
        !manifest.diagnostics?.writer?.droppedRecords &&
        !manifest.diagnostics?.writer?.writeErrors
      await output.write(
        `${JSON.stringify({ type: 'diagnostic-complete', schemaVersion: 1, complete, exportFinished: true, manifest: { ...manifest, ...completeness, storage: { ...stats }, files: current.files.map(({ name, size }) => ({ name, size })) } })}\n`
      )
      await output.write(
        `${JSON.stringify({ type: 'diagnostic-system', schemaVersion: 1, snapshot: systemDiagnostics || { collectionErrors: [{ field: 'system', message: 'System snapshot was not collected' }] } })}\n`
      )
      await output.close()
      output = null
      assertSnapshot(current)
      await rename(temporary, target)
      return { path: target, completeness }
    } finally {
      await output?.close().catch(() => {})
      await unlink(temporary).catch(() => {})
      if (current) releaseSnapshot(current.id)
      exportActive = false
    }
  }

  return {
    append,
    query,
    exportTo,
    files,
    stats: () => ({ ...stats }),
    async freezeExport() {
      const current = await snapshot(true)
      return { id: current.id, expiresAt: current.expiresAt }
    },
    releaseSnapshot,
    async maintain() {
      await cleanup('app')
      await cleanup('detail')
    },
    close() {
      for (const id of snapshots.keys()) releaseSnapshot(id)
    }
  }
}
