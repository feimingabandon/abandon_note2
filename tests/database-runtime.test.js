import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDb, getDb, getDbIfInitialized, setDb } from '../src/main/db/db-connection.js'

const fixture = vi.hoisted(() => ({
  calls: [],
  backupError: null,
  schemaError: null,
  connection: null
}))
vi.mock('../src/main/db/db-connection.js', async (importOriginal) => {
  const connection = await importOriginal()
  return {
    ...connection,
    clearDb: vi.fn(connection.clearDb),
    setDb: vi.fn(connection.setDb)
  }
})
vi.mock('better-sqlite3', () => ({
  default: class Database {
    constructor(path) {
      fixture.calls.push(['open', path])
      return fixture.connection
    }
  }
}))
vi.mock('../src/main/db/db-schema.js', () => ({
  createDatabaseSchema: () => {
    fixture.calls.push(['schema'])
    if (fixture.schemaError) throw fixture.schemaError
  }
}))
vi.mock('../src/main/db/db-migration-backup.js', () => ({
  createDatabaseMigrationBackup: () => {
    fixture.calls.push(['backup'])
    if (fixture.backupError) throw fixture.backupError
  }
}))
import { initializeDatabase, closeDatabase } from '../src/main/db/db-runtime.js'

beforeEach(() => {
  clearDb()
  vi.mocked(clearDb).mockClear()
  vi.mocked(setDb).mockClear()
  fixture.calls = []
  fixture.backupError = null
  fixture.schemaError = null
  fixture.connection = {
    pragma: (value) => fixture.calls.push(['pragma', value]),
    close: () => fixture.calls.push(['close'])
  }
})

describe('database connection lifecycle', () => {
  it('installs the only connection after pragmas, migration backup and schema', () => {
    initializeDatabase({ userDataPath: 'C:/isolated-test-profile' })
    expect(fixture.calls.map(([name]) => name)).toEqual([
      'open',
      'pragma',
      'pragma',
      'pragma',
      'pragma',
      'backup',
      'schema'
    ])
    expect(getDb()).toBe(fixture.connection)
    closeDatabase()
    expect(getDbIfInitialized()).toBeNull()
    expect(fixture.calls.at(-1)).toEqual(['close'])
    closeDatabase()
    expect(fixture.calls.filter(([name]) => name === 'close')).toHaveLength(1)
  })

  it('closes the new connection and leaves no reference when schema initialization fails', () => {
    fixture.schemaError = new Error('schema refused the database')
    expect(() => initializeDatabase({ userDataPath: 'C:/isolated-test-profile' })).toThrow(
      'schema refused the database'
    )
    expect(fixture.calls.at(-1)).toEqual(['close'])
    expect(getDbIfInitialized()).toBeNull()
    expect(() => getDb()).toThrow('数据库尚未初始化')
  })

  it('closes and clears the candidate without migrating or publishing when backup fails', () => {
    fixture.backupError = new Error('migration backup refused the database')
    let initializationError
    try {
      initializeDatabase({ userDataPath: 'C:/isolated-test-profile' })
    } catch (error) {
      initializationError = error
    }

    expect(initializationError).toBe(fixture.backupError)
    expect(fixture.calls.map(([name]) => name)).toEqual([
      'open',
      'pragma',
      'pragma',
      'pragma',
      'pragma',
      'backup',
      'close'
    ])
    expect(setDb).not.toHaveBeenCalled()
    expect(clearDb).toHaveBeenCalledTimes(1)
    expect(getDbIfInitialized()).toBeNull()
    expect(() => getDb()).toThrow('数据库尚未初始化')
  })

  it('rejects reinitialization without opening or replacing another connection', () => {
    initializeDatabase({ userDataPath: 'C:/isolated-test-profile' })
    const before = fixture.calls.length
    expect(() => initializeDatabase({ userDataPath: 'C:/another-profile' })).toThrow(
      '数据库已经初始化'
    )
    expect(fixture.calls).toHaveLength(before)
    expect(getDb()).toBe(fixture.connection)
    closeDatabase()
  })
})
