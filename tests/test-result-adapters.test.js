import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import adapters from '../scripts/test-result-adapters.cjs'

const roots = []
function context() {
  const directory = mkdtempSync(join(tmpdir(), 'abandon-adapter-'))
  roots.push(directory)
  return { directory, startedMs: Date.now() - 100 }
}
function vitestReport(ctx, overrides = {}) {
  const report = {
    startTime: ctx.startedMs + 10,
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: resolve('tests/target.test.js'),
        status: 'passed',
        assertionResults: [{ status: 'passed', title: 'observable target result' }]
      }
    ],
    ...overrides
  }
  writeFileSync(join(ctx.directory, 'vitest.json'), JSON.stringify(report))
  return report
}
const assess = (ctx) => adapters.assessVitestReport(ctx, { file: 'tests/target.test.js' })
const qtAssess = (ctx) =>
  adapters.assessQtReport(ctx, { name: 'capture_core', file: 'native_capture/tests/core_test.cpp' })
function qtReport(ctx, cases = '<testcase name="observableBehavior"/>') {
  writeFileSync(
    join(ctx.directory, 'ctest-selection.json'),
    JSON.stringify({ tests: [{ name: 'capture_core' }] })
  )
  writeFileSync(
    join(ctx.directory, 'ctest-results.xml'),
    '<testsuite><testcase name="capture_core" status="run"/></testsuite>'
  )
  writeFileSync(
    join(ctx.directory, 'capture_core.junit.xml'),
    '<testsuite><testcase name="initTestCase"/>' +
      cases +
      '<testcase name="cleanupTestCase"/></testsuite>'
  )
  writeFileSync(join(ctx.directory, 'capture_core.txt'), 'Current QTest report')
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('target-result proof adapters', () => {
  it('binds Qt business counts to the exact CTest name and current attempt', () => {
    const ctx = context()
    qtReport(ctx)
    expect(qtAssess(ctx)).toMatchObject({
      status: 'passed',
      assertions: { total: 1, passed: 1, failed: 0, skipped: 0 }
    })
    writeFileSync(
      join(ctx.directory, 'ctest-selection.json'),
      JSON.stringify({ tests: [{ name: 'capture_ui' }] })
    )
    expect(qtAssess(ctx).status).toBe('unproven')
  })
  it('refuses Qt setup-only, all-skipped, missing, stale and malformed evidence', () => {
    const ctx = context()
    expect(qtAssess(ctx).status).toBe('unproven')
    qtReport(ctx, '')
    expect(qtAssess(ctx).status).toBe('unproven')
    qtReport(ctx, '<testcase name="business"><skipped/></testcase>')
    expect(qtAssess(ctx).status).toBe('unproven')
    qtReport(ctx)
    const old = new Date(ctx.startedMs - 5000)
    utimesSync(join(ctx.directory, 'capture_core.junit.xml'), old, old)
    expect(qtAssess(ctx).status).toBe('unproven')
    qtReport(ctx)
    writeFileSync(join(ctx.directory, 'ctest-results.xml'), '<testsuite><testcase>')
    expect(qtAssess(ctx).status).toBe('unproven')
  })
  it('keeps a Qt failure including setup failure from passing with process zero', () => {
    const ctx = context()
    qtReport(ctx, '<testcase name="business"><failure/></testcase>')
    expect(qtAssess(ctx)).toMatchObject({ status: 'failed', assertions: { failed: 1 } })
    qtReport(ctx)
    writeFileSync(
      join(ctx.directory, 'capture_core.junit.xml'),
      '<testsuite><testcase name="initTestCase"><failure/></testcase><testcase name="business"/></testsuite>'
    )
    expect(qtAssess(ctx).status).toBe('failed')
  })
  it('uses real completed test cases and never counts expect calls', () => {
    const ctx = context()
    vitestReport(ctx)
    expect(assess(ctx)).toMatchObject({
      status: 'passed',
      mode: 'vitest-json-single-file',
      assertions: { total: 1, passed: 1, failed: 0, skipped: 0 },
      target: 'tests/target.test.js'
    })
  })
  it('does not accept a missing, malformed, or stale report', () => {
    const ctx = context()
    expect(assess(ctx).status).toBe('unproven')
    writeFileSync(join(ctx.directory, 'vitest.json'), '{')
    expect(assess(ctx).status).toBe('unproven')
    vitestReport(ctx)
    const old = new Date(ctx.startedMs - 5000)
    utimesSync(join(ctx.directory, 'vitest.json'), old, old)
    expect(assess(ctx)).toMatchObject({
      status: 'unproven',
      reason: expect.stringContaining('predates')
    })
  })
  it('rejects an old start, wrong file, or unexpected extra target', () => {
    const ctx = context()
    vitestReport(ctx, { startTime: ctx.startedMs - 1 })
    expect(assess(ctx).status).toBe('unproven')
    const report = vitestReport(ctx)
    report.testResults[0].name = resolve('tests/another.test.js')
    writeFileSync(join(ctx.directory, 'vitest.json'), JSON.stringify(report))
    expect(assess(ctx).status).toBe('unproven')
    report.testResults.push({ ...report.testResults[0], name: resolve('tests/target.test.js') })
    writeFileSync(join(ctx.directory, 'vitest.json'), JSON.stringify(report))
    expect(assess(ctx).status).toBe('unproven')
  })
  it('does not count no-match or all-skipped suites as passed', () => {
    const ctx = context()
    vitestReport(ctx, {
      numTotalTests: 0,
      numPassedTests: 0,
      testResults: [
        {
          name: resolve('tests/target.test.js'),
          status: 'passed',
          assertionResults: []
        }
      ]
    })
    expect(assess(ctx).status).toBe('unproven')
    vitestReport(ctx, {
      numPassedTests: 0,
      numPendingTests: 1,
      testResults: [
        {
          name: resolve('tests/target.test.js'),
          status: 'passed',
          assertionResults: [{ status: 'pending' }]
        }
      ]
    })
    expect(assess(ctx)).toMatchObject({ status: 'skipped', assertions: { passed: 0, skipped: 1 } })
  })
  it('keeps skipped counts and failure results separate', () => {
    const ctx = context()
    vitestReport(ctx, {
      success: false,
      numPassedTests: 0,
      numFailedTests: 1,
      testResults: [
        {
          name: resolve('tests/target.test.js'),
          status: 'failed',
          assertionResults: [{ status: 'failed' }]
        }
      ]
    })
    expect(assess(ctx)).toMatchObject({ status: 'failed', assertions: { failed: 1 } })
    vitestReport(ctx, {
      numTotalTests: 2,
      numPendingTests: 1,
      testResults: [
        {
          name: resolve('tests/target.test.js'),
          status: 'passed',
          assertionResults: [{ status: 'passed' }, { status: 'pending' }]
        }
      ]
    })
    expect(assess(ctx)).toMatchObject({
      status: 'passed',
      assertions: { total: 2, passed: 1, skipped: 1 }
    })
  })
  it('reports suite setup failure without assuming a product defect', () => {
    const ctx = context()
    vitestReport(ctx, {
      success: false,
      numTotalTests: 0,
      numPassedTests: 0,
      testResults: [
        {
          name: resolve('tests/target.test.js'),
          status: 'failed',
          assertionResults: []
        }
      ]
    })
    expect(assess(ctx)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('separate evidence')
    })
  })
  it('rejects inconsistent aggregates and unknown assertion states', () => {
    const ctx = context()
    vitestReport(ctx, { numPassedTests: 2 })
    expect(assess(ctx).status).toBe('unproven')
    vitestReport(ctx, {
      testResults: [
        {
          name: resolve('tests/target.test.js'),
          status: 'passed',
          assertionResults: [{ status: 'not-a-known-result' }]
        }
      ]
    })
    expect(assess(ctx).status).toBe('unproven')
  })
  it('refuses an artifact outside the owned attempt', () => {
    const ctx = context(),
      outside = context()
    vitestReport(outside)
    expect(
      adapters.assessVitestReport(ctx, {
        file: 'tests/target.test.js',
        reportFile: join(outside.directory, 'vitest.json')
      })
    ).toMatchObject({ status: 'unproven', reason: expect.stringContaining('current attempt') })
  })

  function standalone(ctx, overrides = {}) {
    const report = {
      version: 1,
      suite: 'tests/attachment-storage-electron.mjs',
      runToken: 'current-token',
      mode: 'electron-ready-memory-sqlite-real-files',
      completed: true,
      assertions: { total: 3, passed: 3, failed: 0, skipped: 0 },
      cleanup: { status: 'complete' },
      evidence: { status: 'complete' },
      profileOwnership: 'runner',
      ...overrides
    }
    writeFileSync(join(ctx.directory, 'standalone.json'), JSON.stringify(report))
    return report
  }
  const storage = (ctx) =>
    adapters.assessStandaloneReport(ctx, {
      file: 'tests/attachment-storage-electron.mjs',
      runToken: 'current-token'
    })
  it('requires current standalone target, mode, and token', () => {
    const ctx = context()
    standalone(ctx)
    expect(storage(ctx)).toMatchObject({ status: 'passed', assertions: { passed: 3 } })
    for (const overrides of [
      { runToken: 'old-token' },
      { suite: 'tests/other.mjs' },
      { mode: 'electron-as-node' },
      { version: 99 }
    ]) {
      standalone(ctx, overrides)
      expect(storage(ctx).status).toBe('unproven')
    }
  })
  it('does not accept missing completion or impossible assertion totals', () => {
    const ctx = context()
    standalone(ctx, { completed: undefined })
    expect(storage(ctx).status).toBe('unproven')
    standalone(ctx, { assertions: { total: 2, passed: 3, failed: 0, skipped: 0 } })
    expect(storage(ctx).status).toBe('unproven')
    standalone(ctx, { assertions: { total: 0, passed: 0, failed: 0, skipped: 0 } })
    expect(storage(ctx).status).toBe('unproven')
  })
  it('keeps successful assertions separate from incomplete evidence and failed cleanup', () => {
    const ctx = context()
    standalone(ctx, {
      evidence: { status: 'incomplete', reason: 'flush timeout' },
      cleanup: { status: 'failed', error: 'close failure' }
    })
    expect(storage(ctx)).toMatchObject({
      status: 'passed',
      assertions: { passed: 3 },
      scriptEvidence: { status: 'incomplete' },
      scriptCleanup: { status: 'failed' }
    })
    standalone(ctx, { cleanup: undefined })
    expect(storage(ctx).status).toBe('unproven')
  })
  it('reports actual assertion failure and incomplete target independently of process zero', () => {
    const ctx = context()
    standalone(ctx, {
      completed: false,
      assertions: { total: 3, passed: 2, failed: 1, skipped: 0 },
      error: 'actual assertion'
    })
    expect(storage(ctx)).toMatchObject({
      status: 'failed',
      assertions: { failed: 1 },
      reason: 'actual assertion'
    })
  })
})
