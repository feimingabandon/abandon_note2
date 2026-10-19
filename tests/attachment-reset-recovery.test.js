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
  journalDeleteFails: false,
  recoveryRemoveFails: false,
  directoryMoveFails: false,
  transactionCalls: 0
}))
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual()
  return {
    ...actual,
    renameSync(source, target, ...args) {
      if (
        basename(String(source)) === 'attachments' &&
        basename(String(target)) === 'attachments'
      ) {
        if (state.directoryMoveFails && source === join(profile, 'attachments'))
          throw Object.assign(new Error('injected directory rename EPERM'), { code: 'EPERM' })
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
    rm(target, ...args) {
      if (state.recoveryRemoveFails && String(target).includes('.attachments-deleting-reset-'))
        throw new Error('recovery rm EACCES')
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
          return { total: state.notes }
        },
        all: () =>
          source.includes('attachment_reset_commits')
            ? [...state.commits].map((operation_id) => ({ operation_id }))
            : state.attachments,
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
const recover = (events) =>
  recoverPendingAttachments({
    userDataPath: profile,
    resolveAttachmentPath: resolver,
    onRecovery: (event) => events.push(event)
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
    journalDeleteFails: false,
    recoveryRemoveFails: false,
    directoryMoveFails: false,
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
