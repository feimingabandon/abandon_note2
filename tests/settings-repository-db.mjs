import { rm } from 'node:fs/promises'
import { app } from 'electron'
import Database from 'better-sqlite3'
import {
  initDatabase,
  closeDatabase,
  getDb,
  getAllSettings as facadeRead,
  setSettingsBatch as facadeWrite,
  clearAllSettings as facadeClearAll,
  clearSettings as facadeClear
} from '../src/main/db/db.js'
import {
  getAllSettings,
  setSettingsBatch,
  runSettingsTransaction,
  clearSettings,
  clearAllSettings
} from '../src/main/db/db-settings-repository.js'
import { createNote, getNoteById } from '../src/main/db/db-notes.js'
import {
  ensureViewSettingsInitialized,
  getViewSettingsScope,
  readApplicationSettings,
  writeApplicationSettings,
  resetCurrentViewSettings
} from '../src/main/settings/application-settings.js'
import { createSettingsRuntime } from '../src/main/settings/settings-runtime.js'
import { createSettingsWriteCoordinator } from '../src/main/settings/settings-write-coordinator.js'
import { createSettingsApplicationCoordinator } from '../src/main/settings/settings-application-coordinator.js'
import { serializeSetting } from '../src/shared/settings-schema.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/settings-repository-db.mjs',
  mode: 'electron-ready-disk-sqlite-reopen-settings',
  metadata: {
    browserWindow: false,
    mainProcessRestart: false,
    diskDatabase: true,
    mixedScopeCoordinator: 'real-repository-outer-transaction-insert-update-triggers-reopen',
    committedApplicationOwner: 'real-default-writers-and-runtime-with-committed-DML-audit',
    applicationBoundary: 'pure-dependency-leaf-and-runtime-provider-ports; no-GUI-or-IPC'
  }
})
const { assert } = recorder

async function verifyCommittedApplicationOwner(noteId) {
  function assertMetadataOnly(projection) {
    const records = Array.isArray(projection) ? projection : [projection]
    for (const record of records) {
      assert.equal(Number.isSafeInteger(record.ledgerRevision), true)
      assert.ok(record.ledgerRevision > 0)
      assert.equal(record.current.phase, 'settled')
      assert.equal(Object.hasOwn(record, 'snapshot'), false)
      assert.ok(
        ['available', 'unavailable', 'not-required', 'pending'].includes(
          record.current.snapshot.status
        )
      )
      assert.equal(
        Object.keys(record.current.snapshot).every((key) =>
          ['status', 'error', 'reason'].includes(key)
        ),
        true
      )
      // E4.3.3 intentionally adds current.snapshot status metadata. The former
      // blanket ban on its key would reject that contract; retain the actual
      // boundary by forbidding canonical values/runtime/source/context payloads
      // anywhere, and permitting only the named snapshot metadata fields above.
      assert.doesNotMatch(
        JSON.stringify(record),
        /"(?:values|runtime|source|context|runtimeToken)"\s*:/
      )
      assert.deepEqual(JSON.parse(JSON.stringify(record)), record)
    }
  }
  // Audit rows participate in the same disk transaction as their target writes.
  // Count committed DML, including same-value UPDATE, rather than claiming that
  // row counts measure outer commits or relying on timestamp granularity.
  getDb().exec(`CREATE TABLE e432_settings_dml_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      window_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT
    );
    CREATE TRIGGER e432_settings_audit_insert AFTER INSERT ON app_settings
    BEGIN
      INSERT INTO e432_settings_dml_audit(operation,window_name,key,value)
      VALUES('INSERT',NEW.window_name,NEW.key,NEW.value);
    END;
    CREATE TRIGGER e432_settings_audit_update AFTER UPDATE ON app_settings
    BEGIN
      INSERT INTO e432_settings_dml_audit(operation,window_name,key,value)
      VALUES('UPDATE',NEW.window_name,NEW.key,NEW.value);
    END;`)
  const readAudit = () => {
    // A second read-only connection cannot observe the owning connection's
    // uncommitted audit rows, including when the owner begins immediately.
    const reader = new Database(getDb().name, { readonly: true })
    try {
      return reader.prepare('SELECT * FROM e432_settings_dml_audit ORDER BY sequence').all()
    } finally {
      reader.close()
    }
  }
  const readRows = (scope) =>
    getDb()
      .prepare(
        `SELECT window_name,type,key,value,remark,created_at,updated_at FROM app_settings
         WHERE window_name IN (?, 'application') ORDER BY window_name,key`
      )
      .all(scope)
  const batchA = [
    { id: 'css.bgColor', value: '171 205 239' },
    { id: 'dock.enabledEdges', value: ['right'] },
    { id: 'window.lockState', value: true },
    { id: 'weather.enabled', value: false }
  ]
  const batchB = [
    { id: 'css.bgColor', value: '34 68 102' },
    { id: 'dock.enabledEdges', value: ['left'] },
    { id: 'window.lockState', value: false },
    { id: 'weather.enabled', value: true }
  ]
  const observedValues = (runtime) => ({
    bgColor: runtime.values.css.bgColor,
    enabledEdges: [...runtime.values.dock.enabledEdges],
    lockState: runtime.values.window.lockState,
    weatherEnabled: runtime.values.weather.enabled
  })
  const valuesA = {
    bgColor: '171 205 239',
    enabledEdges: ['right'],
    lockState: true,
    weatherEnabled: false
  }
  const valuesB = {
    bgColor: '34 68 102',
    enabledEdges: ['left'],
    lockState: false,
    weatherEnabled: true
  }
  const expectedDmlA = (scope) =>
    batchA.map(({ id, value }) => {
      const row = serializeSetting(id, value)
      return {
        window_name: id.startsWith('window.') || id.startsWith('weather.') ? 'application' : scope,
        key: row.key,
        value: row.value
      }
    })

  function fixture(name) {
    const scope = 'main'
    // This helper is invoked only after all original 108 assertions. Rebuild
    // this step's real product scope without clearing unrelated application rows.
    clearSettings(scope)
    setSettingsBatch(scope, [
      serializeSetting('css.bgColor', '18 52 86'),
      serializeSetting('dock.enabledEdges', ['left'])
    ])
    writeApplicationSettings([
      { id: 'window.lockState', value: false },
      { id: 'weather.enabled', value: true }
    ])
    const context = { scope, source: { token: `e432-database-${name}`, scope } }
    const events = []
    const completions = []
    const state = { fault: null }
    let runtime
    const record = (name, extra = {}) => {
      events.push({ name, transactionActive: getDb().inTransaction, ...extra })
    }
    runtime = createSettingsRuntime({
      initialViewMode: 'list',
      getViewMode: () => 'list',
      readApplication: () => {
        if (state.fault === 'resolve') throw new Error('e432 actual settings resolve read failed')
        return readApplicationSettings()
      },
      readViewRows: () => getAllSettings(scope),
      onResolved: () => {
        throw new Error('e432 implicit onResolved must remain suppressed in the new owner')
      },
      readRuntime: () => {
        record('runtime-provider')
        if (state.fault === 'snapshot') throw new Error('e432 runtime snapshot provider failed')
        return { autoStart: { value: false, error: null } }
      }
    })
    runtime.refresh({ notifyResolved: false })
    getDb().exec('DELETE FROM e432_settings_dml_audit')
    const domain = (name, reason) => (request) => {
      record(`${reason}:${name}`, { values: observedValues(runtime), reason: request.reason })
      return state.fault === 'leaf' && name === 'window' ? false : { status: 'applied' }
    }
    const owner = createSettingsApplicationCoordinator({
      getCurrentContext: () => context,
      isContextCurrent: (candidate) =>
        candidate.scope === context.scope &&
        candidate.source.token === context.source.token &&
        candidate.source.scope === context.source.scope,
      refreshResolvedSettings: (options) => {
        record('resolve', { options })
        return runtime.refresh(options)
      },
      dependencies: {
        blurConfig: () => {
          record('dependency:blurConfig')
          if (state.fault === 'dependency') throw new Error('e432 blur config dependency failed')
          return { status: 'applied' }
        },
        remote: () => {
          record('dependency:remote')
          return { status: 'applied' }
        }
      },
      applyDomains: Object.fromEntries(
        ['window', 'blur', 'dock'].map((name) => [name, domain(name, 'apply')])
      ),
      retryDomains: Object.fromEntries(
        ['window', 'blur', 'dock'].map((name) => [name, domain(name, 'retry')])
      ),
      getResolvedSettingsSnapshot: () => {
        record('snapshot')
        return { ...runtime.snapshot(), source: context.source }
      },
      broadcastSettingsChanged: (snapshot) => {
        record('broadcast', { revision: snapshot.revision })
        if (state.fault === 'broadcast') throw new Error('e432 snapshot delivery failed')
      }
    })
    const unexpectedLegacy = () => {
      throw new Error('e432 optional committed owner must replace the legacy post-commit sequence')
    }
    const coordinator = createSettingsWriteCoordinator({
      getActiveWindowName: () => scope,
      // The repository, application writer and transaction ports are deliberately
      // omitted: this exercises their production defaults on the real connection.
      observeVerification: () => ({ enabled: true, reason: 'e432-real-disk-verification' }),
      getDockRuntimeConfig: () => ({ ...runtime.values.dock }),
      refreshResolvedSettings: unexpectedLegacy,
      applyResolvedWindowRuntime: unexpectedLegacy,
      applyResolvedBlurRuntime: unexpectedLegacy,
      reconcileDockRuntimeConfig: unexpectedLegacy,
      getResolvedSettingsSnapshot: unexpectedLegacy,
      broadcastSettingsChanged: unexpectedLegacy,
      completeCommittedSettings: (request) => {
        completions.push({ transactionActive: getDb().inTransaction, audit: readAudit() })
        return owner.completeCommittedSettings({
          ...request,
          verify: () => {
            record('verify')
            const verified = request.verify()
            if (state.fault === 'after-evidence') {
              throw new Error('e432 after-evidence observer failed')
            }
            return verified
          }
        })
      }
    })
    return { scope, context, state, events, completions, runtime, owner, coordinator }
  }

  function assertCommitted(f, beforeAudit, receipt) {
    assert.equal(receipt.persistence.status, 'saved')
    assert.ok(receipt.persistence.commitId)
    assert.equal(f.completions.length, 1)
    assert.equal(f.completions[0].transactionActive, false)
    assert.equal(f.completions[0].audit.length, beforeAudit.length + batchA.length)
    assert.deepEqual(
      readAudit()
        .slice(beforeAudit.length)
        .map(({ window_name, key, value }) => ({
          window_name,
          key,
          value
        })),
      expectedDmlA(f.scope)
    )
    assert.equal(
      getAllSettings(f.scope).find((row) => row.key === 'bg_color').value,
      valuesA.bgColor
    )
    assert.equal(readApplicationSettings().window.lockState, true)
    assert.equal(readApplicationSettings().weather.enabled, false)
    assert.equal(
      f.events.every(({ transactionActive }) => !transactionActive),
      true
    )
    assert.equal(f.events[0].name, 'verify')
    assert.equal(getNoteById(noteId).content, 'B1 保留业务行')
  }

  // Scenario assertions are kept below the fixture so every failure category
  // uses the same real SQL/refresh path and differs only at its named pure port.
  const healthy = fixture('healthy')
  const healthyBefore = readAudit()
  const healthyRevision = healthy.runtime.revision
  const first = await healthy.coordinator.persistSettingValues(batchA)
  assertCommitted(healthy, healthyBefore, first)
  assert.deepEqual(first.source, healthy.context.source)
  assert.equal(first.application.status, 'applied')
  assert.equal(first.application.resolve.status, 'applied')
  assert.equal(first.verification.status, 'completed')
  assert.equal(first.delivery.status, 'completed')
  assert.deepEqual(observedValues({ values: first.values }), valuesA)
  assert.equal(first.revision, healthyRevision + 1)
  assert.deepEqual(healthy.events.find(({ name }) => name === 'resolve').options, {
    incrementRevision: true,
    notifyResolved: false
  })
  assert.deepEqual(
    healthy.events.filter(({ name }) => name.startsWith('apply:')).map(({ values }) => values),
    [valuesA, valuesA, valuesA]
  )
  const beforeSameValue = readAudit()
  const sameValue = await healthy.coordinator.persistSettingValues(batchA)
  assert.equal(sameValue.persistence.status, 'saved')
  assert.notEqual(sameValue.persistence.commitId, first.persistence.commitId)
  assert.equal(readAudit().length, beforeSameValue.length + batchA.length)
  assert.deepEqual(
    readAudit()
      .slice(beforeSameValue.length)
      .map(({ operation }) => operation),
    ['UPDATE', 'UPDATE', 'UPDATE', 'UPDATE']
  )
  assert.deepEqual(observedValues({ values: sameValue.values }), valuesA)

  const rollback = fixture('rollback')
  const rollbackAudit = readAudit()
  const rollbackRows = readRows(rollback.scope)
  getDb().exec(`CREATE TEMP TRIGGER e432_owner_rollback BEFORE INSERT ON app_settings
    WHEN NEW.window_name='application' AND NEW.type='weather' AND NEW.key='enabled'
    BEGIN SELECT RAISE(ABORT,'e432 owner SQL rollback'); END`)
  try {
    assert.throws(
      () => rollback.coordinator.persistSettingValues(batchA),
      /e432 owner SQL rollback/
    )
    assert.equal(getDb().inTransaction, false)
    assert.deepEqual(readAudit(), rollbackAudit)
    assert.deepEqual(readRows(rollback.scope), rollbackRows)
    assert.deepEqual(rollback.completions, [])
    assert.deepEqual(rollback.events, [])
  } finally {
    getDb().exec('DROP TRIGGER e432_owner_rollback')
  }

  for (const fault of [
    'after-evidence',
    'resolve',
    'dependency',
    'leaf',
    'snapshot',
    'broadcast'
  ]) {
    const f = fixture(fault)
    const beforeAudit = readAudit()
    const beforeValues = f.runtime.values
    const beforeRevision = f.runtime.revision
    f.state.fault = fault
    const receipt = await f.coordinator.persistSettingValues(batchA)
    assertCommitted(f, beforeAudit, receipt)
    assert.equal(receipt.verification.status, fault === 'after-evidence' ? 'failed' : 'completed')
    assert.equal(receipt.application.resolve.status, fault === 'resolve' ? 'failed' : 'applied')
    assert.equal(
      receipt.application.status,
      ['resolve', 'dependency', 'leaf'].includes(fault) ? 'failed' : 'applied'
    )
    assert.equal(receipt.application.superseded, false)
    if (fault === 'resolve') {
      assert.equal(receipt.kind, 'settings-saved')
      assert.equal(receipt.snapshot, null)
      assert.equal(Object.hasOwn(receipt, 'values'), false)
      assert.deepEqual(receipt.source, f.context.source)
      assert.equal(receipt.snapshotError.message, 'e432 actual settings resolve read failed')
      assert.equal(f.runtime.values, beforeValues)
      assert.equal(f.runtime.revision, beforeRevision)
      assert.deepEqual(
        f.events.filter(({ name }) =>
          /^(dependency:|apply:|snapshot$|runtime-provider$|broadcast$)/.test(name)
        ),
        []
      )
    } else {
      assert.deepEqual(observedValues(f.runtime), valuesA)
      assert.equal(f.runtime.revision, beforeRevision + 1)
      assert.equal(receipt.application.dependencies.remote.status, 'applied')
      assert.equal(
        receipt.application.dependencies.blurConfig.status,
        fault === 'dependency' ? 'failed' : 'applied'
      )
      if (fault === 'snapshot') {
        assert.equal(receipt.kind, 'settings-saved')
        assert.equal(receipt.snapshot, null)
        assert.equal(Object.hasOwn(receipt, 'values'), false)
        assert.equal(Object.hasOwn(receipt, 'runtime'), false)
        assert.equal(receipt.snapshotError.message, 'e432 runtime snapshot provider failed')
        assert.equal(
          f.events.some(({ name }) => name === 'runtime-provider'),
          true
        )
        assert.equal(
          f.events.some(({ name }) => name === 'broadcast'),
          false
        )
      } else {
        assert.deepEqual(observedValues({ values: receipt.values }), valuesA)
        assert.equal(receipt.revision, f.runtime.revision)
        assert.deepEqual(receipt.source, f.context.source)
      }
    }
    for (const domain of ['window', 'blur', 'dock']) {
      const expected =
        fault === 'resolve' || (fault === 'dependency' && domain === 'blur')
          ? 'deferred'
          : fault === 'leaf' && domain === 'window'
            ? 'failed'
            : 'applied'
      assert.equal(receipt.application.domains[domain].status, expected)
      assert.equal(
        f.events.some(({ name }) => name === `apply:${domain}`),
        fault !== 'resolve' && !(fault === 'dependency' && domain === 'blur')
      )
    }
    assert.equal(
      receipt.delivery.status,
      ['resolve', 'snapshot'].includes(fault)
        ? 'skipped'
        : fault === 'broadcast'
          ? 'failed'
          : 'completed'
    )
    if (fault === 'after-evidence') {
      assert.equal(receipt.verification.error.message, 'e432 after-evidence observer failed')
      assert.equal(receipt.application.status, 'applied')
    }
    if (fault === 'broadcast') {
      assert.equal(receipt.delivery.error.message, 'e432 snapshot delivery failed')
      assert.equal(receipt.application.status, 'applied')
    }
    assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt)
    assertMetadataOnly(f.owner.snapshotLedger(f.scope))
  }

  const retry = fixture('retry-current-saved')
  const retryBefore = readAudit()
  retry.state.fault = 'leaf'
  const savedA = await retry.coordinator.persistSettingValues(batchA)
  assertCommitted(retry, retryBefore, savedA)
  assert.equal(savedA.application.domains.window.status, 'failed')
  assert.deepEqual(observedValues(retry.runtime), valuesA)
  // Deliberately change the current saved data through the real writers without
  // refreshing this runtime. A retry that replays A or skips refresh now fails.
  runSettingsTransaction(() => {
    setSettingsBatch(
      retry.scope,
      batchB
        .filter(({ id }) => !id.startsWith('window.') && !id.startsWith('weather.'))
        .map(({ id, value }) => serializeSetting(id, value))
    )
    writeApplicationSettings(
      batchB.filter(({ id }) => id.startsWith('window.') || id.startsWith('weather.'))
    )
  })
  const savedBAudit = readAudit()
  const savedBRows = readRows(retry.scope)
  assert.equal(savedBAudit.length, retryBefore.length + batchA.length + batchB.length)
  assert.deepEqual(observedValues(retry.runtime), valuesA)
  retry.state.fault = null
  retry.events.length = 0
  const appliedB = await retry.owner.retryAppliedSettings({
    domains: ['window', 'blur', 'dock'],
    context: retry.context
  })
  assert.deepEqual(appliedB.persistence, {
    status: 'unchanged',
    commitId: savedA.persistence.commitId
  })
  assert.equal(appliedB.application.status, 'applied')
  assert.equal(appliedB.verification.status, 'skipped')
  assert.equal(appliedB.delivery.status, 'completed')
  assert.deepEqual(observedValues(retry.runtime), valuesB)
  assert.deepEqual(observedValues({ values: appliedB.values }), valuesB)
  assert.deepEqual(
    retry.events.filter(({ name }) => name.startsWith('retry:')).map(({ values }) => values),
    [valuesB, valuesB, valuesB]
  )
  assert.equal(
    retry.events.some(({ name }) => name.startsWith('apply:') || name === 'verify'),
    false
  )
  assert.deepEqual(retry.events.find(({ name }) => name === 'resolve').options, {
    incrementRevision: false,
    notifyResolved: false
  })
  assert.deepEqual(readAudit(), savedBAudit)
  assert.deepEqual(readRows(retry.scope), savedBRows)
  assert.equal(retry.completions.length, 1)
  assert.equal(retry.owner.snapshotLedger(retry.scope).commitId, savedA.persistence.commitId)
  assertMetadataOnly(retry.owner.snapshotLedger())
  for (const selection of [
    {
      domains: [],
      dependencies: ['remote'],
      calls: ['resolve', 'dependency:remote', 'snapshot', 'runtime-provider', 'broadcast']
    },
    {
      domains: ['blur'],
      dependencies: [],
      calls: [
        'resolve',
        'dependency:blurConfig',
        'retry:blur',
        'snapshot',
        'runtime-provider',
        'broadcast'
      ]
    },
    {
      domains: [],
      dependencies: [],
      calls: ['resolve', 'snapshot', 'runtime-provider', 'broadcast']
    }
  ]) {
    const before = retry.owner.snapshotLedger(retry.scope)
    retry.events.length = 0
    const precise = await retry.owner.retryAppliedSettings({
      domains: selection.domains,
      dependencies: selection.dependencies,
      context: retry.context
    })
    assert.deepEqual(precise.persistence, {
      status: 'unchanged',
      commitId: savedA.persistence.commitId
    })
    assert.equal(precise.application.status, 'applied')
    assert.deepEqual(
      retry.events.map(({ name }) => name),
      selection.calls
    )
    assert.deepEqual(observedValues(retry.runtime), valuesB)
    assert.deepEqual(readAudit(), savedBAudit, 'precise retries never repeat committed SQL DML')
    assert.deepEqual(readRows(retry.scope), savedBRows)
    assert.equal(retry.completions.length, 1)
    const after = retry.owner.snapshotLedger(retry.scope)
    assert.ok(after.ledgerRevision > before.ledgerRevision)
    assert.equal(after.current.reason, 'retry')
    assert.deepEqual(after.current.targets.domains, selection.domains)
    assert.deepEqual(
      after.current.targets.dependencies,
      selection.domains.includes('blur') ? ['blurConfig'] : selection.dependencies
    )
    for (const domain of ['window', 'blur', 'dock'])
      if (!selection.domains.includes(domain))
        assert.deepEqual(after.domains[domain], before.domains[domain])
    for (const name of ['blurConfig', 'remote'])
      if (!after.current.targets.dependencies.includes(name))
        assert.deepEqual(after.dependencies[name], before.dependencies[name])
    assertMetadataOnly(after)
  }
  const beforeInvalidRetry = readAudit()
  await assert.rejects(
    retry.owner.retryAppliedSettings({
      domains: ['window'],
      context: retry.context,
      values: valuesA
    }),
    /应用重试只接受/
  )
  assert.deepEqual(readAudit(), beforeInvalidRetry)
  assert.deepEqual(readRows(retry.scope), savedBRows)
  closeDatabase()
  assert.equal(initDatabase().isNewDatabase, false)
  assert.deepEqual(readAudit(), savedBAudit)
  assert.deepEqual(readRows(retry.scope), savedBRows)
  assert.deepEqual(readApplicationSettings().window.lockState, valuesB.lockState)
  assert.equal(getNoteById(noteId).content, 'B1 保留业务行')
}

app.once('ready', async () => {
  let profile = null
  let completed = false
  let failure = null
  let exitCode = 0
  const cleanupErrors = []
  try {
    profile = prepareTestProfile({ prefix: 'abandon-settings-db-' })
    app.setPath('userData', profile.directory)
    assert.equal(initDatabase().isNewDatabase, true)
    assert.equal(facadeRead, getAllSettings)
    assert.equal(facadeWrite, setSettingsBatch)
    assert.equal(facadeClear, clearSettings)
    assert.equal(facadeClearAll, clearAllSettings)
    const note = createNote({ content: 'B1 保留业务行' })
    assert.equal(getNoteById(note.id).content, 'B1 保留业务行')

    setSettingsBatch('main', [{ type: 'first', key: 'same_key', value: 'old', remark: 'initial' }])
    const original = getAllSettings('main')[0]
    setSettingsBatch('main', [{ type: 'second', key: 'same_key', value: 42, remark: 'updated' }])
    const changed = getAllSettings('main')
    assert.equal(changed.length, 1)
    assert.equal(changed[0].type, 'second')
    assert.equal(changed[0].value, '42')
    assert.equal(changed[0].created_at, original.created_at)
    assert.equal(changed[0].remark, 'updated')
    setSettingsBatch('month', [{ type: 'second', key: 'same_key', value: null }])
    assert.equal(getAllSettings('month')[0].value, null)
    assert.equal(getAllSettings('main')[0].value, '42')

    getDb().exec(`CREATE TEMP TRIGGER b1_settings_failure BEFORE INSERT ON app_settings
      WHEN NEW.key = 'b1_reject' BEGIN SELECT RAISE(ABORT, 'injected settings write'); END;`)
    assert.throws(
      () =>
        setSettingsBatch('main', [
          { type: 'second', key: 'same_key', value: 'must rollback' },
          { type: 'second', key: 'b1_reject', value: 'reject' }
        ]),
      /injected settings write/
    )
    assert.deepEqual(getAllSettings('main'), changed)
    getDb().exec('DROP TRIGGER b1_settings_failure')
    assert.equal(setSettingsBatch('main', []), undefined)

    const applicationWindow = {
      lockState: true,
      zOrderMode: 'bottom',
      compactWidth: 356,
      compactHeight: 88,
      compactFontSize: 22
    }
    const legacyMonthWindow = {
      lockState: false,
      zOrderMode: 'normal',
      compactWidth: 540,
      compactHeight: 120,
      compactFontSize: 14
    }
    writeApplicationSettings([
      { id: 'weather.enabled', value: true },
      { id: 'almanac.enabled', value: false },
      ...Object.entries(applicationWindow).map(([key, value]) => ({ id: `window.${key}`, value }))
    ])
    const applicationBeforeInheritance = getAllSettings('application')
    assert.deepEqual(readApplicationSettings().window, applicationWindow)
    const legacyMonthRows = Object.entries(legacyMonthWindow).map(([key, value]) =>
      serializeSetting(`window.${key}`, value)
    )
    const unknownViewRow = {
      type: 'legacy-view',
      key: 'e4_unknown_view_setting',
      value: 'preserve unknown historical view data',
      remark: 'E4.1 未知历史视图行'
    }
    setSettingsBatch('month', [
      serializeSetting('geometry.width', 1200),
      ...legacyMonthRows,
      unknownViewRow
    ])
    for (const row of legacyMonthRows) {
      assert.equal(
        getAllSettings('month').find((stored) => stored.key === row.key)?.value,
        row.value
      )
    }
    assert.equal(ensureViewSettingsInitialized('week'), true)
    const inherited = getAllSettings('week')
    assert.equal(inherited.find((row) => row.key === 'width')?.value, '1200')
    assert.equal(inherited.find((row) => row.key === 'same_key')?.value, null)
    assert.deepEqual(
      inherited
        .filter((row) => row.key === unknownViewRow.key)
        .map(({ type, key, value, remark }) => ({ type, key, value, remark })),
      [unknownViewRow]
    )
    for (const row of legacyMonthRows) {
      // The persisted identity is window_name + key; a different type cannot
      // make an application setting eligible for a second per-view row.
      assert.equal(
        getDb()
          .prepare('SELECT COUNT(*) AS count FROM app_settings WHERE window_name = ? AND key = ?')
          .get('week', row.key).count,
        0
      )
    }
    assert.deepEqual(
      getAllSettings('application').filter((row) => row.key !== 'week_settings_initialized'),
      applicationBeforeInheritance
    )
    assert.equal(readApplicationSettings().weather.enabled, true)
    assert.equal(readApplicationSettings().almanac.enabled, false)
    assert.equal(readApplicationSettings().window.lockState, true)
    assert.deepEqual(readApplicationSettings().window, applicationWindow)

    let view = 'month'
    const runtime = createSettingsRuntime({
      getViewMode: () => view,
      readApplication: readApplicationSettings,
      readViewRows: (mode) => getAllSettings(getViewSettingsScope(mode)),
      readRuntime: () => ({ autoStart: { value: false, error: null } })
    })
    runtime.refresh()
    assert.deepEqual(runtime.snapshot().values.window, applicationWindow)
    runtime.setShortcutsEnabled(false)
    view = 'week'
    runtime.resetForView(view)
    runtime.refresh({ incrementRevision: true })
    assert.equal(runtime.snapshot().values.geometry.width, 1200)
    assert.equal(runtime.snapshot().values.weather.enabled, true)
    assert.equal(runtime.snapshot().values.almanac.enabled, false)
    assert.equal(runtime.snapshot().values.shortcuts.enabled, false)
    assert.deepEqual(runtime.snapshot().values.window, applicationWindow)
    assert.equal(runtime.revision, 3)

    closeDatabase()
    assert.throws(() => getAllSettings('main'), /数据库尚未初始化/)
    assert.equal(initDatabase().isNewDatabase, false)
    assert.equal(readApplicationSettings().almanac.enabled, false)
    assert.equal(getAllSettings('main')[0].value, '42')
    assert.equal(readApplicationSettings().weather.enabled, true)
    assert.deepEqual(readApplicationSettings().window, applicationWindow)
    assert.deepEqual(getAllSettings('week'), inherited)
    assert.equal(ensureViewSettingsInitialized('week'), false)
    assert.equal(clearSettings('week'), inherited.length)
    assert.equal(ensureViewSettingsInitialized('week'), false)
    assert.deepEqual(getAllSettings('week'), [])
    assert.equal(getAllSettings('month').find((row) => row.key === 'width')?.value, '1200')
    assert.equal(readApplicationSettings().weather.enabled, true)
    assert.equal(getNoteById(note.id).content, 'B1 保留业务行')
    setSettingsBatch('main', [serializeSetting('geometry.width', 777)])
    const beforeResetApplication = getAllSettings('application')
    const beforeResetMain = getAllSettings('main')
    const beforeResetMonth = getAllSettings('month')
    getDb().exec(`CREATE TEMP TRIGGER q001_reset_failure BEFORE DELETE ON app_settings
      WHEN OLD.window_name='main' BEGIN SELECT RAISE(ABORT,'Q001 view reset failure'); END`)
    assert.throws(() => resetCurrentViewSettings('list'), /Q001 view reset failure/)
    assert.deepEqual(getAllSettings('application'), beforeResetApplication)
    assert.deepEqual(getAllSettings('main'), beforeResetMain)
    assert.deepEqual(getAllSettings('month'), beforeResetMonth)
    getDb().exec('DROP TRIGGER q001_reset_failure')
    const resetResult = resetCurrentViewSettings('list')
    assert.ok(resetResult.resetApplicationSettingCount > 0)
    assert.equal(resetResult.clearedViewSettingCount, beforeResetMain.length)
    assert.deepEqual(getAllSettings('main'), [])
    assert.deepEqual(getAllSettings('month'), beforeResetMonth)
    assert.equal(readApplicationSettings().weather.enabled, false)
    assert.equal(readApplicationSettings().almanac.enabled, true)
    assert.deepEqual(readApplicationSettings().window, {
      lockState: false,
      zOrderMode: 'top',
      compactWidth: 180,
      compactHeight: 48,
      compactFontSize: 17
    })
    assert.equal(getNoteById(note.id).content, 'B1 保留业务行')
    const settingsCount = getDb().prepare('SELECT COUNT(*) AS count FROM app_settings').get().count
    assert.equal(clearAllSettings(), settingsCount)
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM app_settings').get().count, 0)
    assert.equal(getNoteById(note.id).content, 'B1 保留业务行')

    // Keep the original repository/reset/inheritance sequence above intact. This
    // isolated scope exercises the real coordinator and both production writers
    // on getDb()'s current connection, including after close/init in this process.
    const atomicScope = 'atomic-main'
    setSettingsBatch(atomicScope, [
      serializeSetting('css.bgColor', '18 52 86'),
      serializeSetting('dock.enabledEdges', ['left']),
      { type: 'atomic-legacy', key: 'atomic_untouched', value: null, remark: 'retain this row' }
    ])
    writeApplicationSettings([
      { id: 'window.lockState', value: false },
      { id: 'weather.enabled', value: true },
      { id: 'almanac.enabled', value: false }
    ])
    const readAtomicRows = () =>
      getDb()
        .prepare(
          `SELECT window_name,type,key,value,remark,created_at,updated_at
           FROM app_settings WHERE window_name IN (?, 'application')
           ORDER BY window_name,key`
        )
        .all(atomicScope)
    const atomicBefore = readAtomicRows()
    const atomicApplicationBefore = getAllSettings('application')
    const atomicViewBefore = getAllSettings(atomicScope)
    const atomicEffects = []
    const effect = (name) => {
      atomicEffects.push({ name, transactionActive: getDb().inTransaction })
    }
    const atomicSnapshot = {
      source: { token: 'atomic-database-test', scope: 'main' },
      revision: 1,
      values: { marker: 'pure snapshot port; assertions read actual SQLite separately' }
    }
    const coordinator = createSettingsWriteCoordinator({
      getActiveWindowName: () => atomicScope,
      // Do not replace getAllSettings/setSettingsBatch/writeApplicationSettings
      // or runSettingsTransaction: all SQL and nested transactions are real.
      observeVerification: () => ({ enabled: false, reason: 'skipped-policy' }),
      refreshResolvedSettings: () => effect('refresh'),
      applyResolvedWindowRuntime: () => effect('window'),
      applyResolvedBlurRuntime: () => effect('blur'),
      getDockRuntimeConfig: () => ({ enabledEdges: ['left'] }),
      reconcileDockRuntimeConfig: () => effect('dock'),
      getResolvedSettingsSnapshot: () => {
        effect('snapshot')
        return atomicSnapshot
      },
      broadcastSettingsChanged: () => effect('broadcast')
    })
    const atomicBatch = [
      { id: 'css.bgColor', value: '171 205 239' },
      { id: 'dock.enabledEdges', value: ['right'] },
      { id: 'window.lockState', value: true },
      { id: 'weather.enabled', value: false }
    ]
    for (const operation of ['INSERT', 'UPDATE']) {
      const trigger = `e43_atomic_${operation.toLowerCase()}_failure`
      getDb().exec(`CREATE TEMP TRIGGER ${trigger} BEFORE ${operation} ON app_settings
        WHEN NEW.window_name='application' AND NEW.type='weather' AND NEW.key='enabled'
        BEGIN
          SELECT CASE WHEN (SELECT value FROM app_settings
            WHERE window_name='atomic-main' AND key='bg_color') IS NOT '171 205 239'
            THEN RAISE(ABORT,'view scope did not write before application scope') END;
          SELECT CASE WHEN (SELECT value FROM app_settings
            WHERE window_name='application' AND key='lock_state') IS NOT 'true'
            THEN RAISE(ABORT,'first application row did not write before rejection') END;
          SELECT RAISE(ABORT,'injected mixed-scope ${operation} failure');
        END`)
      try {
        assert.throws(
          () => coordinator.persistSettingValues(atomicBatch),
          new RegExp(`injected mixed-scope ${operation} failure`)
        )
        assert.equal(getDb().inTransaction, false)
        assert.deepEqual(getAllSettings(atomicScope), atomicViewBefore)
        assert.deepEqual(getAllSettings('application'), atomicApplicationBefore)
        assert.deepEqual(readAtomicRows(), atomicBefore)
        assert.deepEqual(atomicEffects, [])
      } finally {
        getDb().exec(`DROP TRIGGER ${trigger}`)
      }
      closeDatabase()
      assert.equal(initDatabase().isNewDatabase, false)
      assert.deepEqual(readAtomicRows(), atomicBefore)
      assert.deepEqual(getAllSettings(atomicScope), atomicViewBefore)
      assert.deepEqual(getAllSettings('application'), atomicApplicationBefore)
      assert.equal(getNoteById(note.id).content, 'B1 保留业务行')
    }

    assert.equal(coordinator.persistSettingValues(atomicBatch), atomicSnapshot)
    assert.deepEqual(atomicEffects, [
      { name: 'refresh', transactionActive: false },
      { name: 'window', transactionActive: false },
      { name: 'blur', transactionActive: false },
      { name: 'dock', transactionActive: false },
      { name: 'snapshot', transactionActive: false },
      { name: 'broadcast', transactionActive: false }
    ])
    assert.equal(
      getAllSettings(atomicScope).find((row) => row.key === 'bg_color')?.value,
      '171 205 239'
    )
    assert.equal(
      getAllSettings(atomicScope).find((row) => row.key === 'dock_enabled_edges')?.value,
      '["right"]'
    )
    assert.deepEqual(
      getAllSettings(atomicScope).find((row) => row.key === 'atomic_untouched'),
      atomicViewBefore.find((row) => row.key === 'atomic_untouched')
    )
    assert.equal(readApplicationSettings().window.lockState, true)
    assert.equal(readApplicationSettings().weather.enabled, false)
    assert.deepEqual(
      getAllSettings('application').find((row) => row.type === 'almanac'),
      atomicApplicationBefore.find((row) => row.type === 'almanac')
    )
    const atomicCommitted = readAtomicRows()
    assert.notDeepEqual(atomicCommitted, atomicBefore)
    closeDatabase()
    assert.equal(initDatabase().isNewDatabase, false)
    assert.deepEqual(readAtomicRows(), atomicCommitted)
    assert.equal(readApplicationSettings().window.lockState, true)
    assert.equal(readApplicationSettings().weather.enabled, false)
    assert.equal(getNoteById(note.id).content, 'B1 保留业务行')
    await verifyCommittedApplicationOwner(note.id)
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
    console.error(error)
  } finally {
    try {
      closeDatabase()
    } catch (error) {
      cleanupErrors.push(error.message)
      exitCode = 1
    }
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
