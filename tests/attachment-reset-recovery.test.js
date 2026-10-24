import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  cpSync,
  rmSync
} from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const state = vi.hoisted(() => ({
  notes: 1,
  attachments: [],
  commits: new Set(),
  markerFails: false,
  resetFails: false,
  journalReadFails: false,
  journalListFails: false,
  journalDeleteFails: false,
  recoveryRemoveFails: false,
  stagingRemoveFails: false,
  orphanRemoveFails: false,
  directoryReadFails: null,
  referenceReadFails: false,
  observationError: null,
  directoryMoveFails: false,
  restoreMoveFails: false,
  transactionCalls: 0
}))
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual()
  return {
    ...actual,
    statSync(target, ...args) {
      if (state.observationError && target === resolver(oldRelative))
        throw Object.assign(new Error(`observation ${state.observationError}`), {
          code: state.observationError
        })
      return actual.statSync(target, ...args)
    },
    renameSync(source, target, ...args) {
      if (
        basename(String(source)) === 'attachments' &&
        basename(String(target)) === 'attachments'
      ) {
        if (state.directoryMoveFails && source === join(profile, 'attachments'))
          throw Object.assign(new Error('injected directory rename EPERM'), { code: 'EPERM' })
        if (state.restoreMoveFails && source !== join(profile, 'attachments'))
          throw Object.assign(new Error('injected restore rename EPERM'), { code: 'EPERM' })
        return moveFixtureDirectory(source, target)
      }
      return actual.renameSync(source, target, ...args)
    },
    writeFileSync(target, ...args) {
      if (state.markerFails && String(target).endsWith('committed'))
        throw Object.assign(new Error('marker EACCES'), { code: 'EACCES' })
      return actual.writeFileSync(target, ...args)
    }
  }
})
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual()
  return {
    ...actual,
    readdir(target, ...args) {
      if (
        (state.directoryReadFails === 'root' && target === profile) ||
        (state.directoryReadFails === 'staging' && basename(target) === '.attachments-staging')
      )
        throw Object.assign(new Error(`readdir ${state.directoryReadFails} EACCES`), {
          code: 'EACCES'
        })
      return actual.readdir(target, ...args)
    },
    rm(target, ...args) {
      if (state.recoveryRemoveFails && String(target).includes('.attachments-deleting-reset-'))
        throw new Error('recovery rm EACCES')
      if (state.stagingRemoveFails && String(target).includes('.attachments-staging'))
        throw new Error('staging rm EACCES')
      if (state.orphanRemoveFails && target === resolver(oldRelative))
        throw new Error('orphan rm EACCES')
      return actual.rm(target, ...args)
    }
  }
})
vi.mock('../src/main/db/db-connection.js', () => ({
  getDb: () => ({
    transaction: (body) => {
      state.transactionCalls += 1
      return () => {
        const snapshot = {
          notes: state.notes,
          attachments: [...state.attachments],
          commits: new Set(state.commits)
        }
        try {
          return body()
        } catch (error) {
          Object.assign(state, snapshot)
          throw error
        }
      }
    },
    prepare(source) {
      return {
        get(id) {
          if (source.includes('attachment_reset_commits')) {
            if (state.journalReadFails) throw new Error('journal SELECT failed')
            return state.commits.has(id) ? { operation_id: id } : undefined
          }
          if (source.includes('SELECT 1 FROM note_attachments')) {
            if (state.referenceReadFails) throw new Error('reference SELECT failed')
            return state.attachments.find((row) => row.file_path === id)
          }
          return { total: state.notes }
        },
        all: () => {
          if (source.includes('attachment_reset_commits')) {
            if (state.journalListFails) throw new Error('journal enumeration failed')
            return [...state.commits].map((operation_id) => ({ operation_id }))
          }
          return state.attachments
        },
        run(id) {
          if (source.startsWith('INSERT INTO attachment_reset_commits')) state.commits.add(id)
          if (source.startsWith('DELETE FROM attachment_reset_commits')) {
            if (state.journalDeleteFails) throw new Error('journal DELETE failed')
            state.commits.delete(id)
          }
          if (source === 'DELETE FROM note_attachments') state.attachments = []
          if (source === 'DELETE FROM notes') {
            if (state.resetFails) throw new Error('reset SQL failed')
            state.notes = 0
          }
        }
      }
    }
  })
}))
import { resetBusinessData } from '../src/main/db/business-data-reset.js'
import { recoverPendingAttachments } from '../src/main/db/attachment-recovery.js'
import { createAttachmentRecoveryReport } from '../src/main/db/attachment-recovery-report.js'

let profile
// This unit suite models SQLite decisions and directory-move outcomes. Copy/remove keeps its
// real byte assertions deterministic; it does not model rename atomicity. Actual Windows
// rename is exercised by attachment-storage-electron and attachment-recovery-reset-electron.
function moveFixtureDirectory(source, target) {
  if (existsSync(target))
    throw Object.assign(new Error('fixture move target already exists'), { code: 'EEXIST' })
  cpSync(source, target, { recursive: true, errorOnExist: true, force: false })
  rmSync(source, { recursive: true })
}
const resolver = (relativePath) => join(profile, relativePath)
const recover = (events, report) =>
  recoverPendingAttachments({
    userDataPath: profile,
    resolveAttachmentPath: resolver,
    onRecovery: (event) => events.push(event),
    ...(report ? { report } : {})
  })
const oldRelative = join('attachments', 'images', '1', 'old.png')
beforeEach(() => {
  const fixtureRoot = resolve(import.meta.dirname, '../tmp')
  mkdirSync(fixtureRoot, { recursive: true })
  profile = mkdtempSync(join(fixtureRoot, 'abandon-reset-unit-'))
  Object.assign(state, {
    notes: 1,
    attachments: [{ file_path: oldRelative }],
    commits: new Set(),
    markerFails: false,
    resetFails: false,
    journalReadFails: false,
    journalListFails: false,
    journalDeleteFails: false,
    recoveryRemoveFails: false,
    stagingRemoveFails: false,
    orphanRemoveFails: false,
    directoryReadFails: null,
    referenceReadFails: false,
    observationError: null,
    directoryMoveFails: false,
    restoreMoveFails: false,
    transactionCalls: 0
  })
  mkdirSync(join(profile, 'attachments', 'images', '1'), { recursive: true })
  writeFileSync(resolver(oldRelative), 'old attachment bytes')
})
afterEach(() => {
  rmSync(profile, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('reset transaction decision and exact operation recovery', () => {
  it('rejects directory isolation before SQL while preserving data and safely cleaning its empty operation', async () => {
    state.directoryMoveFails = true
    await expect(resetBusinessData({ userDataPath: profile })).rejects.toMatchObject({
      code: 'EPERM'
    })
    expect(state.transactionCalls).toBe(0)
    expect(state.notes).toBe(1)
    expect(state.attachments).toEqual([{ file_path: oldRelative }])
    expect(state.commits.size).toBe(0)
    expect(readFileSync(resolver(oldRelative), 'utf8')).toBe('old attachment bytes')
    const directory = readdirSync(profile).find((entry) =>
      entry.startsWith('.attachments-deleting-reset-')
    )
    expect(directory).toBeDefined()
    const manifest = JSON.parse(readFileSync(join(profile, directory, 'operation.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: 2, type: 'reset' })
    expect(directory).toBe(`.attachments-deleting-reset-${manifest.operationId}`)
    expect(existsSync(join(profile, directory, 'attachments'))).toBe(false)
    const events = []
    await recover(events)
    expect(existsSync(join(profile, directory))).toBe(false)
    expect(events.some((event) => event.action === 'cleanup-unneeded')).toBe(true)
    expect(state.notes).toBe(1)
    expect(state.attachments).toEqual([{ file_path: oldRelative }])
    expect(state.commits.size).toBe(0)
    expect(readFileSync(resolver(oldRelative), 'utf8')).toBe('old attachment bytes')
  })

  it('uses the committed operation journal after marker/remove fail and unrelated new rows appear', async () => {
    state.markerFails = true
    await resetBusinessData({
      userDataPath: profile,
      removeDirectory: async () => {
        throw new Error('rm EACCES')
      }
    })
    state.notes = 1
    const events = []
    await recover(events)
    expect(existsSync(resolver(oldRelative))).toBe(false)
    expect(state.commits.size).toBe(0)
    expect(events.some((event) => event.action === 'committed-cleanup')).toBe(true)
    expect(
      readdirSync(profile).some((entry) => entry.startsWith('.attachments-deleting-reset-'))
    ).toBe(false)
  })

  it('records a v2 operation and journal in the same transaction while retaining failed cleanup', async () => {
    await resetBusinessData({
      userDataPath: profile,
      removeDirectory: async () => {
        throw new Error('rm EACCES')
      }
    })
    const directory = readdirSync(profile).find((entry) =>
      entry.startsWith('.attachments-deleting-reset-')
    )
    const manifest = JSON.parse(readFileSync(join(profile, directory, 'operation.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: 2, type: 'reset' })
    expect(directory).toBe(`.attachments-deleting-reset-${manifest.operationId}`)
    expect(state.commits.has(manifest.operationId)).toBe(true)
  })

  it('does not record a commit when reset SQL rolls back and restores its old bytes', async () => {
    state.resetFails = true
    await expect(resetBusinessData({ userDataPath: profile })).rejects.toThrow('reset SQL failed')
    expect(state.commits.size).toBe(0)
    expect(state.notes).toBe(1)
    expect(readFileSync(resolver(oldRelative), 'utf8')).toBe('old attachment bytes')
  })

  it('preserves a legacy undecidable payload rather than inferring commit from current row counts', async () => {
    const directory = join(profile, '.attachments-deleting-reset-legacy')
    mkdirSync(join(directory, 'attachments', 'images', '2'), { recursive: true })
    writeFileSync(join(directory, 'operation.json'), JSON.stringify({ version: 1, type: 'reset' }))
    writeFileSync(
      join(directory, 'attachments', 'images', '2', 'orphan.png'),
      'unknown legacy bytes'
    )
    state.notes = 0
    state.attachments = []
    const events = []
    await recover(events)
    expect(existsSync(directory)).toBe(true)
    expect(events.some((event) => event.action === 'preserved-ambiguous-legacy')).toBe(true)
  })

  it('recovers a legacy uncommitted payload only when current attachment records reference its actual files', async () => {
    const directory = join(profile, '.attachments-deleting-reset-legacy-reference')
    mkdirSync(directory)
    moveFixtureDirectory(join(profile, 'attachments'), join(directory, 'attachments'))
    writeFileSync(join(directory, 'operation.json'), JSON.stringify({ version: 1, type: 'reset' }))
    const events = []
    await recover(events)
    expect(readFileSync(resolver(oldRelative), 'utf8')).toBe('old attachment bytes')
    expect(events.some((event) => event.action === 'rolled-back')).toBe(true)
  })

  it('preserves v2 payload on journal read failure and rejects cross-operation manifest identity', async () => {
    const operationId = randomUUID()
    const directory = join(profile, `.attachments-deleting-reset-${operationId}`)
    mkdirSync(join(directory, 'attachments'), { recursive: true })
    writeFileSync(
      join(directory, 'operation.json'),
      JSON.stringify({ version: 2, type: 'reset', operationId })
    )
    state.journalReadFails = true
    const events = []
    await recover(events)
    expect(existsSync(directory)).toBe(true)
    expect(events.some((event) => event.action === 'failed-preserved')).toBe(true)
    state.journalReadFails = false
    writeFileSync(
      join(directory, 'operation.json'),
      JSON.stringify({ version: 2, type: 'reset', operationId: randomUUID() })
    )
    const invalid = []
    await recover(invalid)
    expect(existsSync(directory)).toBe(true)
    expect(invalid.some((event) => event.action === 'failed-preserved')).toBe(true)
    expect(basename(directory)).toContain(operationId)
  })

  it('cleans a journal left after its payload directory was already deleted', async () => {
    const operationId = randomUUID()
    state.commits.add(operationId)
    await recover([])
    expect(state.commits.size).toBe(0)
  })

  it('does not revoke a committed clear when journal cleanup fails and retries the orphan journal', async () => {
    state.journalDeleteFails = true
    await expect(resetBusinessData({ userDataPath: profile })).resolves.toBeUndefined()
    expect(state.notes).toBe(0)
    expect(existsSync(resolver(oldRelative))).toBe(false)
    expect(
      readdirSync(profile).some((entry) => entry.startsWith('.attachments-deleting-reset-'))
    ).toBe(false)
    expect(state.commits.size).toBe(1)
    state.notes = 1
    const events = []
    await expect(recover(events)).resolves.toBeUndefined()
    expect(state.commits.size).toBe(1)
    expect(events.some((event) => event.action === 'journal-cleanup-pending')).toBe(true)
    expect(existsSync(resolver(oldRelative))).toBe(false)
    state.journalDeleteFails = false
    await recover([])
    expect(state.commits.size).toBe(0)
    expect(state.notes).toBe(1)
  })

  it('preserves committed bytes and decision when recovery removal fails, then retries without rollback', async () => {
    await resetBusinessData({
      userDataPath: profile,
      removeDirectory: async () => {
        throw new Error('rm EACCES')
      }
    })
    const directory = readdirSync(profile).find((entry) =>
      entry.startsWith('.attachments-deleting-reset-')
    )
    state.recoveryRemoveFails = true
    state.notes = 1
    const events = []
    await recover(events)
    expect(existsSync(join(profile, directory, 'attachments', 'images', '1', 'old.png'))).toBe(true)
    expect(existsSync(resolver(oldRelative))).toBe(false)
    expect(state.commits.size).toBe(1)
    expect(events.some((event) => event.action === 'failed-preserved')).toBe(true)
    state.recoveryRemoveFails = false
    await recover([])
    expect(existsSync(join(profile, directory))).toBe(false)
    expect(state.commits.size).toBe(0)
    expect(existsSync(resolver(oldRelative))).toBe(false)
  })

  it('preserves a new attachment root while an uncommitted v2 operation waits for rollback', async () => {
    const operationId = randomUUID()
    const directory = join(profile, `.attachments-deleting-reset-${operationId}`)
    mkdirSync(directory)
    moveFixtureDirectory(join(profile, 'attachments'), join(directory, 'attachments'))
    writeFileSync(
      join(directory, 'operation.json'),
      JSON.stringify({ version: 2, type: 'reset', operationId })
    )
    mkdirSync(join(profile, 'attachments'))
    writeFileSync(join(profile, 'attachments', 'new.png'), 'new root bytes')
    const events = []
    await recover(events)
    expect(readFileSync(join(profile, 'attachments', 'new.png'), 'utf8')).toBe('new root bytes')
    expect(existsSync(join(directory, 'attachments', 'images', '1', 'old.png'))).toBe(true)
    expect(events.some((event) => event.action === 'preserved-conflict')).toBe(true)
    rmSync(join(profile, 'attachments'), { recursive: true })
    const rolledBack = []
    await recover(rolledBack)
    expect(readFileSync(resolver(oldRelative), 'utf8')).toBe('old attachment bytes')
    expect(existsSync(directory)).toBe(false)
    expect(rolledBack.some((event) => event.action === 'rolled-back')).toBe(true)
  })

  it('cleans a v2 operation interrupted before payload isolation without touching the original root', async () => {
    const operationId = randomUUID()
    const directory = join(profile, `.attachments-deleting-reset-${operationId}`)
    mkdirSync(directory)
    writeFileSync(
      join(directory, 'operation.json'),
      JSON.stringify({ version: 2, type: 'reset', operationId })
    )
    const events = []
    await recover(events)
    expect(readFileSync(resolver(oldRelative), 'utf8')).toBe('old attachment bytes')
    expect(existsSync(directory)).toBe(false)
    expect(events.some((event) => event.action === 'cleanup-unneeded')).toBe(true)
  })

  it('preserves a v2 marker that contradicts a missing database decision', async () => {
    const operationId = randomUUID()
    const directory = join(profile, `.attachments-deleting-reset-${operationId}`)
    mkdirSync(join(directory, 'attachments'), { recursive: true })
    writeFileSync(
      join(directory, 'operation.json'),
      JSON.stringify({ version: 2, type: 'reset', operationId })
    )
    writeFileSync(join(directory, 'committed'), '')
    const events = []
    await recover(events)
    expect(existsSync(directory)).toBe(true)
    expect(events.some((event) => event.action === 'failed-preserved')).toBe(true)
    expect(readFileSync(resolver(oldRelative), 'utf8')).toBe('old attachment bytes')
  })
})

function createReportedReset({ committed = false } = {}) {
  const operationId = randomUUID()
  const directory = join(profile, `.attachments-deleting-reset-${operationId}`)
  mkdirSync(directory)
  moveFixtureDirectory(join(profile, 'attachments'), join(directory, 'attachments'))
  writeFileSync(
    join(directory, 'operation.json'),
    JSON.stringify({ version: 2, type: 'reset', operationId })
  )
  if (committed) state.commits.add(operationId)
  return { operationId, directory }
}

function createReportedImageOperation(type) {
  const operationId = `${type}-${randomUUID()}`
  const directory = join(profile, '.attachments-staging', operationId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'operation.json'),
    JSON.stringify({ version: 1, type, relativePath: oldRelative })
  )
  if (type === 'image-add')
    writeFileSync(
      join(directory, 'target.json'),
      JSON.stringify({ version: 1, type: 'image-add-target', relativePath: oldRelative })
    )
  return { operationId, directory }
}

describe('attachment recovery report observations', () => {
  it('starts unobserved and returns independent in-memory snapshots without implying a full reference scan', async () => {
    const report = createAttachmentRecoveryReport()
    expect(report.snapshot()).toMatchObject({
      schemaVersion: 1,
      scope: 'pending-attachment-recovery-round',
      status: 'undetermined',
      phase: 'not-started',
      partial: true,
      roundId: null,
      startedAt: null,
      finishedAt: null,
      failure: null,
      operations: []
    })
    // This referenced file is outside any pending operation: the report does not audit it.
    rmSync(resolver(oldRelative))
    await expect(recover([], report)).resolves.toBeUndefined()
    const first = report.snapshot()
    expect(first).toMatchObject({ status: 'completed', phase: 'finished', partial: false })
    expect(first.roundId).toEqual(expect.any(String))
    expect(first.startedAt).toEqual(expect.any(String))
    expect(first.finishedAt).toEqual(expect.any(String))
    first.counts.completed = 999
    first.operations.push({ status: 'completed' })
    state.directoryReadFails = 'root'
    state.journalListFails = true
    state.observationError = 'EACCES'
    expect(report.snapshot().operations).toEqual([])
    expect(report.snapshot().counts.completed).toBe(0)
    expect(() => report.start()).toThrow('只能用于一轮恢复')
  })

  it('keeps a committed removal failure distinct from an unknown database decision', async () => {
    const { directory } = createReportedReset({ committed: true })
    state.recoveryRemoveFails = true
    const committed = createAttachmentRecoveryReport()
    const events = []
    await recover(events, committed)
    expect(committed.snapshot()).toMatchObject({
      status: 'cleanupPending',
      partial: false,
      counts: { cleanupPending: 1, undetermined: 0 },
      operations: [
        {
          operationType: 'reset',
          decision: 'committed',
          status: 'cleanupPending',
          action: 'failed-preserved',
          failurePhase: 'cleanup-operation',
          reason: 'recovery rm EACCES'
        }
      ]
    })
    expect(events).toEqual([
      {
        operationId: basename(directory),
        operationType: 'reset',
        action: 'failed-preserved',
        reason: 'recovery rm EACCES'
      }
    ])
    state.recoveryRemoveFails = false
    state.journalReadFails = true
    const unknown = createAttachmentRecoveryReport()
    await recover([], unknown)
    expect(unknown.snapshot()).toMatchObject({
      counts: { cleanupPending: 0, undetermined: 1 },
      operations: [{ decision: 'unknown', status: 'undetermined', failurePhase: 'read-decision' }]
    })
    expect(existsSync(directory)).toBe(true)
  })

  it.each([
    ['rename', 'undetermined', 'restore-payload'],
    ['cleanup', 'cleanupPending', 'cleanup-operation']
  ])('distinguishes incomplete rollback from %s failure', async (kind, status, failurePhase) => {
    const { directory } = createReportedReset()
    state.restoreMoveFails = kind === 'rename'
    state.recoveryRemoveFails = kind === 'cleanup'
    const report = createAttachmentRecoveryReport()
    await recover([], report)
    expect(report.snapshot().operations).toMatchObject([
      { decision: 'uncommitted', status, failurePhase }
    ])
    const retained =
      kind === 'rename'
        ? join(directory, 'attachments', 'images', '1', 'old.png')
        : resolver(oldRelative)
    expect(readFileSync(retained, 'utf8')).toBe('old attachment bytes')
  })

  it.each(['image-add', 'image-delete'])(
    'reports an actually missing referenced %s file without changing its old cleanup event',
    async (type) => {
      const { operationId, directory } = createReportedImageOperation(type)
      rmSync(resolver(oldRelative))
      const report = createAttachmentRecoveryReport()
      const events = []
      await recover(events, report)
      expect(report.snapshot()).toMatchObject({
        status: 'referenceMissing',
        counts: { referenceMissing: 1, completed: 0 },
        operations: [
          {
            operationId,
            operationType: type,
            decision: type === 'image-add' ? 'committed' : 'uncommitted',
            statuses: ['referenceMissing']
          }
        ]
      })
      expect(events).toEqual([
        {
          operationId,
          operationType: type,
          action: type === 'image-add' ? 'committed-cleanup' : 'cleanup-missing-payload',
          ...(type === 'image-add' ? { deletedFiles: 0 } : {})
        }
      ])
      expect(existsSync(directory)).toBe(false)
      const detached = report.snapshot()
      detached.operations[0].statuses.length = 0
      detached.operations[0].observations[0].reason = 'changed by reader'
      expect(report.snapshot().operations[0].statuses).toEqual(['referenceMissing'])
      expect(report.snapshot().operations[0].observations[0].reason).not.toBe('changed by reader')
    }
  )

  it('retains overlapping missing-reference and cleanup-pending facts for one operation', async () => {
    createReportedImageOperation('image-add')
    rmSync(resolver(oldRelative))
    state.stagingRemoveFails = true
    const report = createAttachmentRecoveryReport()
    await recover([], report)
    expect(report.snapshot()).toMatchObject({
      status: 'referenceMissing',
      counts: { referenceMissing: 1, cleanupPending: 1, completed: 0 },
      operations: [{ statuses: ['referenceMissing', 'cleanupPending'] }]
    })
  })

  it('does not call an incomplete delete rollback cleanup-only merely because its decision is known', async () => {
    createReportedImageOperation('image-delete')
    rmSync(resolver(oldRelative))
    state.stagingRemoveFails = true
    const report = createAttachmentRecoveryReport()
    await recover([], report)
    expect(report.snapshot()).toMatchObject({
      status: 'undetermined',
      counts: { referenceMissing: 1, cleanupPending: 0, undetermined: 1 },
      operations: [{ decision: 'uncommitted', statuses: ['undetermined', 'referenceMissing'] }]
    })
  })

  it('keeps a failed final orphan deletion undetermined until the rollback has actually completed', async () => {
    const { operationId, directory } = createReportedImageOperation('image-add')
    state.attachments = []
    state.orphanRemoveFails = true
    const report = createAttachmentRecoveryReport()
    const events = []
    await expect(recover(events, report)).resolves.toBeUndefined()
    expect(report.snapshot()).toMatchObject({
      status: 'undetermined',
      partial: false,
      counts: { completed: 0, cleanupPending: 0, undetermined: 1 },
      operations: [
        {
          operationId,
          operationType: 'image-add',
          decision: 'uncommitted',
          action: 'failed-preserved',
          status: 'undetermined',
          failurePhase: 'cleanup-orphan',
          reason: 'orphan rm EACCES'
        }
      ]
    })
    expect(events).toEqual([
      {
        operationId,
        operationType: 'unknown',
        action: 'failed-preserved',
        reason: 'orphan rm EACCES'
      }
    ])
    expect(readFileSync(resolver(oldRelative), 'utf8')).toBe('old attachment bytes')
    expect(JSON.parse(readFileSync(join(directory, 'operation.json'), 'utf8'))).toMatchObject({
      version: 1,
      type: 'image-add'
    })
    expect(JSON.parse(readFileSync(join(directory, 'target.json'), 'utf8'))).toMatchObject({
      version: 1,
      type: 'image-add-target',
      relativePath: oldRelative
    })
    expect(state.attachments).toEqual([])
  })

  it.each(['EACCES', 'reference-query'])(
    'preserves old cleanup when the extra reference observation fails with %s',
    async (kind) => {
      const { directory } = createReportedImageOperation('image-delete')
      state.observationError = kind === 'EACCES' ? 'EACCES' : null
      state.referenceReadFails = kind === 'reference-query'
      const report = createAttachmentRecoveryReport()
      const events = []
      await expect(recover(events, report)).resolves.toBeUndefined()
      expect(report.snapshot()).toMatchObject({
        status: 'undetermined',
        counts: { referenceMissing: 0, undetermined: 1 },
        operations: [{ action: 'cleanup-missing-payload', failurePhase: 'observe-reference' }]
      })
      expect(events).toHaveLength(1)
      expect(events[0].action).toBe('cleanup-missing-payload')
      expect(existsSync(directory)).toBe(false)
      expect(readFileSync(resolver(oldRelative), 'utf8')).toBe('old attachment bytes')
    }
  )

  it.each([
    ['root', 'scan-root'],
    ['staging', 'scan-staging'],
    ['journal', 'scan-journals']
  ])(
    'keeps %s enumeration failures partial and propagates their original error',
    async (kind, phase) => {
      mkdirSync(join(profile, '.attachments-staging'), { recursive: true })
      if (kind === 'journal') state.journalListFails = true
      else state.directoryReadFails = kind
      const report = createAttachmentRecoveryReport()
      const events = []
      const error = kind === 'journal' ? 'journal enumeration failed' : `readdir ${kind} EACCES`
      await expect(recover(events, report)).rejects.toThrow(error)
      expect(report.snapshot()).toMatchObject({
        status: 'undetermined',
        phase: 'failed',
        partial: true,
        failure: { phase, reason: error }
      })
      expect(events).toEqual([])
    }
  )

  it('keeps the original two callback attempts and propagates the same final error', async () => {
    createReportedReset({ committed: true })
    const report = createAttachmentRecoveryReport()
    const error = new Error('callback unavailable')
    const calls = []
    await expect(
      recoverPendingAttachments({
        userDataPath: profile,
        resolveAttachmentPath: resolver,
        report,
        onRecovery(event) {
          calls.push(event)
          throw error
        }
      })
    ).rejects.toBe(error)
    expect(calls.map((event) => event.action)).toEqual(['committed-cleanup', 'failed-preserved'])
    expect(report.snapshot()).toMatchObject({
      phase: 'failed',
      partial: true,
      failure: { phase: 'recover-reset', reason: error.message },
      operations: [{ status: 'undetermined', failurePhase: 'notify' }]
    })
  })

  it('preserves already completed operations when a later journal enumeration fails', async () => {
    const { directory } = createReportedImageOperation('image-add')
    const report = createAttachmentRecoveryReport()
    state.journalListFails = true
    const events = []
    await expect(recover(events, report)).rejects.toThrow('journal enumeration failed')
    expect(report.snapshot()).toMatchObject({
      status: 'undetermined',
      partial: true,
      failure: { phase: 'scan-journals', reason: 'journal enumeration failed' },
      counts: { completed: 1 },
      operations: [{ status: 'completed', action: 'committed-cleanup' }]
    })
    expect(events).toHaveLength(1)
    expect(existsSync(directory)).toBe(false)
  })

  it('reports and preserves an invalid journal ID without resolving it or emitting an old event', async () => {
    const invalidOperationId = '../untrusted-reset-id'
    state.commits.add(invalidOperationId)
    const resolvePath = vi.fn(() => {
      throw new Error('invalid journal ID must not be resolved')
    })
    const report = createAttachmentRecoveryReport()
    const events = []
    await expect(
      recoverPendingAttachments({
        userDataPath: profile,
        resolveAttachmentPath: resolvePath,
        onRecovery: (event) => events.push(event),
        report
      })
    ).resolves.toBeUndefined()
    expect(state.commits).toEqual(new Set([invalidOperationId]))
    expect(resolvePath).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(report.snapshot()).toMatchObject({
      status: 'undetermined',
      phase: 'finished',
      partial: false,
      counts: { completed: 0, undetermined: 1 },
      operations: [
        {
          operationId: invalidOperationId,
          operationType: 'reset',
          action: null,
          decision: 'unknown',
          status: 'undetermined',
          failurePhase: 'validate-journal-id',
          reason: '附件清空提交日志操作 ID 无效，原样保留'
        }
      ]
    })
  })

  it('reports a referenced directory as undetermined while retaining its bytes and old cleanup', async () => {
    const { operationId, directory } = createReportedImageOperation('image-add')
    rmSync(resolver(oldRelative))
    mkdirSync(resolver(oldRelative))
    const retainedPath = join(resolver(oldRelative), 'retained.txt')
    writeFileSync(retainedPath, 'directory contents must survive')
    const report = createAttachmentRecoveryReport()
    const events = []
    await expect(recover(events, report)).resolves.toBeUndefined()
    expect(report.snapshot()).toMatchObject({
      status: 'undetermined',
      counts: { completed: 0, referenceMissing: 0, undetermined: 1 },
      operations: [
        {
          operationId,
          decision: 'committed',
          action: 'committed-cleanup',
          status: 'undetermined',
          failurePhase: 'observe-reference',
          reason: '附件引用目标不是普通文件'
        }
      ]
    })
    expect(events).toEqual([
      {
        operationId,
        operationType: 'image-add',
        action: 'committed-cleanup',
        deletedFiles: 0
      }
    ])
    expect(readFileSync(retainedPath, 'utf8')).toBe('directory contents must survive')
    expect(existsSync(directory)).toBe(false)
  })
})
