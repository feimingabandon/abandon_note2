import Database from 'better-sqlite3'
import { app } from 'electron'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createRecurringNoteSnapshot } from '../src/main/db/db-notes.js'
import {
  moveHistoricalNotesToToday,
  previewHistoricalNotesToToday
} from '../src/main/db/db-historical-note-move.js'
import { runAutomaticNoteMove } from '../src/main/services/automatic-note-move.js'
import { registerBusinessIpcHandlers } from '../src/main/ipc/register-business-ipc.js'
import { createBusinessMutationAdmission } from '../src/main/application/business-mutation-admission.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/historical-note-move-db.mjs',
  mode: 'electron-ready-disk-sqlite-historical-and-automatic-move',
  metadata: {
    diskDatabase: true,
    diskConnectionReopen: true,
    browserWindow: false,
    mainProcessRestart: false,
    runtimeAppBootstrap: false
  }
})
const { assert } = recorder
const ts = (day, hour = 8) => new Date(2026, 9, day, hour).getTime()
const now = ts(15, 10)

app.once('ready', async () => {
  let db,
    profile,
    completed = false,
    failure,
    exitCode = 0
  const cleanupErrors = []
  try {
    profile = prepareTestProfile({ prefix: 'abandon-historical-note-move-' })
    app.setPath('userData', profile.directory)
    const path = join(profile.directory, 'test.db')
    db = new Database(path)
    createDatabaseSchema(db)
    setDb(db)
    const seed = (content, fields = {}) =>
      Number(
        db
          .prepare(
            `INSERT INTO notes (content, remark, status, is_deleted, is_pinned,
         effective_at, duration_kind, duration_days, from_template,
         notify_enabled, reminder_channels, finished_at, created_at, updated_at)
       VALUES (?, '保留备注', ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
          )
          .run(
            content,
            fields.status ?? 'in_progress',
            fields.is_deleted ?? 0,
            ts(fields.day ?? 14, fields.hour ?? 8),
            fields.duration_kind ?? 'single_day',
            fields.duration_days ?? 1,
            fields.from_template ?? 0,
            fields.reminder_channels ?? 0,
            ts(2),
            ts(1),
            ts(3)
          ).lastInsertRowid
      )
    const read = (id) => db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
    const onlyDay = {
      scope: 'range',
      startDateKey: '2026-10-14',
      endDateKey: '2026-10-14',
      targetDateKey: '2026-10-15'
    }
    const ordinary = seed('单日原便签', { reminder_channels: 3 })
    const recurring = seed('已生成的循环实例', { from_template: 1 })
    const fixed = seed('固定多天便签', { duration_kind: 'fixed_days', duration_days: 3 })
    const until = seed('持续到完成', { duration_kind: 'until_completed' })
    const older = seed('更早的便签', { day: 13 })
    const today = seed('今天', { day: 15, hour: 0 })
    const future = seed('未来', { day: 16, status: 'initialized' })
    const completedNote = seed('已完成', { status: 'completed' })
    const deleted = seed('已删除', { is_deleted: 1 })
    const pending = seed('未开始', { status: 'initialized' })
    db.prepare('INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)').run(
      '保留标签',
      '#007aff',
      ts(1)
    )
    db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, 1)').run(ordinary)
    db.prepare(
      'INSERT INTO note_attachments (note_id, file_path, file_size, created_at) VALUES (?, ?, ?, ?)'
    ).run(ordinary, 'attachments/preserved.png', 12, ts(1))
    db.prepare(
      `INSERT INTO note_reminders (id, note_id, due_at, state, created_at, updated_at)
      VALUES ('future-snooze', ?, ?, 'scheduled', ?, ?)`
    ).run(ordinary, ts(16), ts(14), ts(14))
    const original = read(ordinary)
    const relations = () => ({
      tags: db.prepare('SELECT * FROM note_tags').all(),
      attachments: db.prepare('SELECT * FROM note_attachments').all(),
      reminders: db.prepare('SELECT * FROM note_reminders').all()
    })
    const originalRelations = relations()
    const first = previewHistoricalNotesToToday({ ...onlyDay, limit: 2 }, { now })
    assert.equal(first.count, 4)
    assert.equal(first.movableCount, 2)
    assert.equal(first.disabledCount, 2)
    assert.equal(first.hasMore, true)
    const second = previewHistoricalNotesToToday({ ...onlyDay, limit: 2, offset: 2 }, { now })
    assert.equal(second.hasMore, false)
    const candidates = [...first.notes, ...second.notes]
    assert.equal(new Set(candidates.map((note) => note.id)).size, 4)
    assert.deepEqual(
      candidates
        .filter((note) => note.canMove)
        .map((note) => note.id)
        .sort(),
      [ordinary, recurring].sort()
    )
    assert.equal(
      candidates.find((note) => note.id === until).disabledReason,
      '已持续显示到今天，无需移动'
    )
    assert.equal(
      candidates.find((note) => note.id === fixed).disabledReason,
      '已设置指定天数，不能移动'
    )
    assert.deepEqual(read(ordinary), original, '预览不得写入任何字段')
    assert.deepEqual(relations(), originalRelations)
    assert.equal(previewHistoricalNotesToToday({ scope: 'all' }, { now }).count, 5)

    assert.throws(
      () =>
        moveHistoricalNotesToToday(
          { ...onlyDay, targetDateKey: '2026-10-14', noteIds: [ordinary] },
          { now }
        ),
      /日期已变化/
    )
    assert.throws(() => moveHistoricalNotesToToday(onlyDay, { now }), /请选择/)
    assert.equal(moveHistoricalNotesToToday({ ...onlyDay, noteIds: [] }, { now }).count, 0)
    assert.throws(
      () =>
        moveHistoricalNotesToToday(
          { ...onlyDay, noteIds: [ordinary], excludedNoteIds: [] },
          { now }
        ),
      /不能同时/
    )
    assert.equal(
      moveHistoricalNotesToToday(
        {
          ...onlyDay,
          noteIds: [ordinary, fixed, until, older, today, future, completedNote, deleted, pending]
        },
        { now }
      ).count,
      1
    )
    assert.deepEqual(
      read(ordinary),
      { ...original, effective_at: now, updated_at: now },
      '移动只改生效和更新时间'
    )
    assert.deepEqual(
      relations(),
      originalRelations,
      '合法后续提醒、标签和附件完整保留，不生成新提醒'
    )
    assert.equal(
      moveHistoricalNotesToToday({ ...onlyDay, noteIds: [ordinary] }, { now }).count,
      0,
      '重复提交不再移动今天的便签'
    )
    assert.equal(
      moveHistoricalNotesToToday({ ...onlyDay, excludedNoteIds: [recurring] }, { now }).count,
      0
    )
    assert.equal(
      moveHistoricalNotesToToday({ ...onlyDay, excludedNoteIds: [] }, { now }).count,
      1,
      '循环真实实例按普通单日便签移动'
    )
    assert.equal(read(recurring).effective_at, now)
    assert.equal(read(older).effective_at, ts(13), '范围外不动')
    for (const id of [fixed, until, completedNote, deleted, pending])
      assert.equal(read(id).effective_at, ts(14))
    assert.equal(read(today).effective_at, ts(15, 0))
    assert.equal(read(future).effective_at, ts(16))
    assert.equal(
      moveHistoricalNotesToToday(
        { scope: 'all', targetDateKey: '2026-10-15', noteIds: [older] },
        { now }
      ).count,
      1
    )

    // 预览后被完成、删除、改变持续方式或移入今天的记录，提交时都需重新判定。
    const changed = [seed('改为完成'), seed('改为删除'), seed('改为持续'), seed('已移动')]
    previewHistoricalNotesToToday(onlyDay, { now })
    db.prepare("UPDATE notes SET status = 'completed' WHERE id = ?").run(changed[0])
    db.prepare('UPDATE notes SET is_deleted = 1 WHERE id = ?').run(changed[1])
    db.prepare("UPDATE notes SET duration_kind = 'until_completed' WHERE id = ?").run(changed[2])
    db.prepare('UPDATE notes SET effective_at = ? WHERE id = ?').run(now, changed[3])
    assert.equal(moveHistoricalNotesToToday({ ...onlyDay, noteIds: changed }, { now }).count, 0)

    // 大量 ID 仍保持单条原子更新，不受 SQLite 绑定参数个数限制。
    const mass = db.transaction(() =>
      Array.from({ length: 1005 }, (_, index) => seed(`多页便签 ${index}`))
    )()
    assert.equal(
      moveHistoricalNotesToToday({ ...onlyDay, noteIds: mass }, { now }).count,
      mass.length
    )
    const atomic = [seed('原子一'), seed('原子二')]
    db.exec(`CREATE TRIGGER reject_manual_move BEFORE UPDATE OF effective_at ON notes
      WHEN OLD.id = ${atomic[1]} BEGIN SELECT RAISE(ABORT, 'move rejected'); END`)
    assert.throws(
      () => moveHistoricalNotesToToday({ ...onlyDay, noteIds: atomic }, { now }),
      /move rejected/
    )
    assert.equal(read(atomic[0]).effective_at, ts(14), '任一更新失败则整批回滚')
    db.exec('DROP TRIGGER reject_manual_move')

    // 自动仅处理昨天的非循环便签；生成实例不随普通待办逐日累积。
    const previous = seed('自动普通')
    const autoRecurring = createRecurringNoteSnapshot({
      content: '自动循环',
      effectiveAt: ts(14)
    }).id
    const autoRecurringBefore = read(autoRecurring)
    assert.equal(autoRecurringBefore.from_template, 1, '真实生成入口保留循环来源')
    const autoOld = seed('自动前天', { day: 13 })
    assert.equal(runAutomaticNoteMove({ enabled: false, now }).skipped, true)
    assert.equal(
      db.prepare("SELECT value FROM app_settings WHERE key = 'auto_move_checked_date'").get(),
      undefined
    )
    const auto = runAutomaticNoteMove({ enabled: true, now })
    assert.equal(auto.count, 3, '两条原子测试余项加一条普通自动候选，循环实例排除')
    assert.equal(auto.sourceDateKey, '2026-10-14')
    assert.equal(read(previous).effective_at, now)
    assert.deepEqual(read(autoRecurring), autoRecurringBefore, '自动移动不改循环实例任何字段')
    assert.equal(read(autoOld).effective_at, ts(13))
    assert.equal(
      db.prepare("SELECT type FROM app_settings WHERE key = 'auto_move_checked_date'").get().type,
      'notes'
    )
    const late = seed('首次检查后补录')
    db.close()
    db = new Database(path)
    setDb(db)
    assert.equal(
      runAutomaticNoteMove({ enabled: true, now: now + 60000 }).reason,
      'already-checked'
    )
    assert.equal(read(late).effective_at, ts(14))
    assert.equal(
      runAutomaticNoteMove({ enabled: true, now: ts(14) }).reason,
      'already-checked',
      '时钟回拨不重跑'
    )
    assert.equal(
      runAutomaticNoteMove({ enabled: true, now, force: true }).count,
      1,
      '重新开启可强制补检查昨天'
    )
    assert.deepEqual(read(autoRecurring), autoRecurringBefore, '强制补检查也排除循环实例')
    const nextRecurring = createRecurringNoteSnapshot({
      content: '新一天的循环实例',
      effectiveAt: ts(15)
    }).id
    const nextRecurringBefore = read(nextRecurring)
    const snapshotBefore = db
      .prepare('SELECT id, effective_at, updated_at FROM notes ORDER BY id')
      .all()
    db.exec(`CREATE TRIGGER reject_auto_checkpoint BEFORE UPDATE ON app_settings
      WHEN NEW.key = 'auto_move_checked_date' BEGIN SELECT RAISE(ABORT, 'checkpoint rejected'); END`)
    assert.throws(() => runAutomaticNoteMove({ enabled: true, now: ts(16) }), /checkpoint rejected/)
    assert.deepEqual(
      db.prepare('SELECT id, effective_at, updated_at FROM notes ORDER BY id').all(),
      snapshotBefore,
      '自动检查标记失败回滚所有移动'
    )
    assert.equal(
      db.prepare("SELECT value FROM app_settings WHERE key = 'auto_move_checked_date'").get().value,
      '2026-10-15'
    )
    db.exec('DROP TRIGGER reject_auto_checkpoint')
    assert.ok(runAutomaticNoteMove({ enabled: true, now: ts(16) }).count > 0)
    assert.deepEqual(read(autoRecurring), autoRecurringBefore, '更早的循环实例继续保留')
    assert.deepEqual(read(nextRecurring), nextRecurringBefore, '下一天不搬前一日循环实例')
    assert.equal(read(recurring).effective_at, now, '手动移过的循环实例也不再次自动移动')
    const thirdRecurring = createRecurringNoteSnapshot({
      content: '再一天的循环实例',
      effectiveAt: ts(16)
    }).id
    const thirdRecurringBefore = read(thirdRecurring)
    assert.ok(runAutomaticNoteMove({ enabled: true, now: ts(17) }).count > 0)
    assert.deepEqual(read(thirdRecurring), thirdRecurringBefore)
    assert.equal(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM notes WHERE from_template = 1 AND effective_at >= ?'
        )
        .get(ts(17, 0)).count,
      0,
      '连续自动移动后，今天不会累积前几天的循环实例'
    )
    assert.equal(
      runAutomaticNoteMove({ enabled: true, now: ts(19) }).count,
      0,
      '停用多天只搬昨天，不扫更早积压'
    )
    assert.deepEqual(relations(), originalRelations, '自动移动也不改变提醒与附件标签')
    // 使用真实业务注册器校验授权、提交后广播和清空/退出写入闸门。
    const ipcNote = seed('IPC 原便签', { day: 18 })
    const handlers = new Map(),
      broadcasts = []
    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (...args) => broadcasts.push(args) }
    }
    const admission = createBusinessMutationAdmission()
    registerBusinessIpcHandlers({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      getMainWindow: () => window,
      runMutation: admission.run
    })
    const previousNow = Date.now
    Date.now = () => ts(19)
    try {
      const selection = {
        scope: 'range',
        startDateKey: '2026-10-18',
        endDateKey: '2026-10-18',
        targetDateKey: '2026-10-19',
        noteIds: [ipcNote]
      }
      const event = { sender: window.webContents }
      assert.throws(
        () => handlers.get('notes:preview-historical-move')({ sender: {} }, selection),
        /无权访问/
      )
      assert.throws(
        () => handlers.get('notes:move-historical-to-today')({ sender: {} }, selection),
        /无权访问/
      )
      assert.equal(handlers.get('notes:preview-historical-move')(event, selection).movableCount, 1)
      assert.throws(
        () =>
          handlers.get('notes:move-historical-to-today')(
            event,
            { ...selection, targetDateKey: '2026-10-18' },
            { validateTargetDate: false }
          ),
        /日期已变化/
      )
      assert.equal(handlers.get('notes:move-historical-to-today')(event, selection).count, 1)
      assert.ok(
        broadcasts.some(
          ([channel, payload]) =>
            channel === 'notes:changed' && payload.reason === 'manual-historical-move'
        )
      )
      const priorBroadcastCount = broadcasts.length
      assert.equal(handlers.get('notes:move-historical-to-today')(event, selection).count, 0)
      assert.equal(broadcasts.length, priorBroadcastCount, '空移动不发无效广播')
      admission.preventNewMutations()
      assert.throws(
        () => handlers.get('notes:move-historical-to-today')(event, selection),
        /正在退出/
      )
      assert.equal(
        handlers.get('notes:preview-historical-move')(event, selection).movableCount,
        0,
        '写入关闭时只读预览仍可用'
      )
    } finally {
      Date.now = previousNow
    }
    completed = true
    console.log(
      'historical/automatic note move: mixed durations, paging, selection, reminder preservation, revalidation, rollback and reopen idempotency passed'
    )
  } catch (error) {
    failure = error
    exitCode = 1
    console.error(error)
  } finally {
    clearDb()
    if (db?.open) db.close()
    if (profile?.ownership === 'script' && !exitCode) {
      try {
        await rm(profile.directory, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(error.message)
        exitCode = 1
      }
    }
    try {
      recorder.finish({
        completed,
        error: failure,
        evidence: { status: 'complete' },
        profileOwnership: profile?.ownership,
        cleanup: {
          status: cleanupErrors.length ? 'failed' : exitCode ? 'preserved' : 'complete',
          ...(cleanupErrors.length ? { error: cleanupErrors.join('\n') } : {}),
          ...(exitCode && profile ? { preservedProfile: profile.directory } : {})
        }
      })
    } catch (error) {
      console.error(error)
      exitCode = 1
    }
    app.exit(exitCode)
  }
})
