const fs = require('node:fs')
const path = require('node:path')

function unproven(reason, mode, extra = {}) {
  return { status: 'unproven', mode, reason, ...extra }
}

function readAttemptFile(context, reportFile) {
  const base = fs.realpathSync(context.directory)
  const file = path.resolve(reportFile)
  const relative = path.relative(base, file)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error('Report must belong to the current attempt directory')
  const actual = fs.realpathSync(file)
  const directStat = fs.lstatSync(file)
  if (directStat.isSymbolicLink() || directStat.nlink !== 1 || actual !== file)
    throw new Error('Report must not be linked')
  const actualRelative = path.relative(base, actual)
  if (
    !actualRelative ||
    actualRelative === '..' ||
    actualRelative.startsWith('..' + path.sep) ||
    path.isAbsolute(actualRelative)
  )
    throw new Error('Report resolves outside the current attempt')
  const stat = fs.statSync(actual)
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
    throw new Error('Report is not a bounded regular file')
  if (stat.mtimeMs < context.startedMs) throw new Error('Report predates this attempt')
  return fs.readFileSync(actual, 'utf8').replace(/^\uFEFF/, '')
}

function readAttemptReport(context, reportFile) {
  return JSON.parse(readAttemptFile(context, reportFile))
}

function sameFile(actual, expected, root) {
  if (typeof actual !== 'string' || !actual) return false
  const left = path.resolve(root, actual)
  const right = path.resolve(root, expected)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function assessVitestReport(context, { file, root = process.cwd(), reportFile } = {}) {
  const mode = 'vitest-json-single-file'
  let report
  try {
    report = readAttemptReport(context, reportFile || path.join(context.directory, 'vitest.json'))
  } catch (error) {
    return unproven(error.message, mode)
  }
  if (!Number.isFinite(report.startTime) || report.startTime < context.startedMs)
    return unproven('Vitest report is not bound to this attempt start', mode)
  if (
    !Array.isArray(report.testResults) ||
    report.testResults.length !== 1 ||
    !sameFile(report.testResults[0].name, file, root)
  )
    return unproven('Vitest did not report exactly the selected target file', mode)
  const suite = report.testResults[0]
  if (!Array.isArray(suite.assertionResults))
    return unproven('Vitest target assertion results are absent', mode)
  const counts = { total: suite.assertionResults.length, passed: 0, failed: 0, skipped: 0 }
  for (const assertion of suite.assertionResults) {
    if (assertion.status === 'passed') counts.passed++
    else if (assertion.status === 'failed') counts.failed++
    else if (['pending', 'skipped', 'todo', 'disabled'].includes(assertion.status)) counts.skipped++
    else return unproven('Vitest assertion has an unknown completion state', mode)
  }
  if (
    ![
      report.numTotalTests,
      report.numPassedTests,
      report.numFailedTests,
      report.numPendingTests,
      report.numTodoTests || 0
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    report.numTotalTests !== counts.total ||
    report.numPassedTests !== counts.passed ||
    report.numFailedTests !== counts.failed ||
    report.numPendingTests + (report.numTodoTests || 0) !== counts.skipped
  )
    return unproven('Vitest aggregate counts disagree with target results', mode, {
      assertions: counts
    })
  if (suite.status === 'failed' || counts.failed > 0 || report.success === false)
    return {
      status: 'failed',
      mode,
      assertions: counts,
      reason:
        'Vitest reported failed tests or suite setup; product cause requires separate evidence'
    }
  if (suite.status !== 'passed' || report.success !== true)
    return unproven('Vitest target suite completion is not confirmed', mode, { assertions: counts })
  if (!counts.total)
    return unproven('Vitest reported no target tests', mode, { assertions: counts })
  if (!counts.passed)
    return { status: 'skipped', mode, assertions: counts, reason: 'All target tests were skipped' }
  return {
    status: 'passed',
    mode,
    assertions: counts,
    target: file,
    limits: [
      'Counts are completed Vitest test cases, not expect() calls',
      'Does not prove product desktop/database/native behavior outside this target'
    ]
  }
}

function assessStandaloneReport(context, { file, suite = file, runToken, mode } = {}) {
  const expectedMode = mode || 'electron-ready-memory-sqlite-real-files'
  let report
  try {
    report = readAttemptReport(context, path.join(context.directory, 'standalone.json'))
  } catch (error) {
    return unproven(error.message, expectedMode)
  }
  if (
    report.version !== 1 ||
    report.suite !== suite ||
    !runToken ||
    report.runToken !== runToken ||
    report.mode !== expectedMode
  )
    return unproven('Standalone report does not match target, mode, or attempt token', expectedMode)
  const counts = report.assertions
  if (
    !counts ||
    !['total', 'passed', 'failed', 'skipped'].every(
      (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0
    ) ||
    counts.total !== counts.passed + counts.failed + counts.skipped
  )
    return unproven('Standalone assertion counts are invalid', expectedMode)
  const extra = {
    assertions: counts,
    target: file,
    scriptCleanup: report.cleanup,
    scriptEvidence: report.evidence,
    profileOwnership: report.profileOwnership,
    metadata: report.metadata
  }
  if (counts.failed || report.completed === false)
    return {
      status: 'failed',
      mode: expectedMode,
      reason: report.error || 'Standalone target did not complete',
      ...extra
    }
  if (report.completed !== true || !counts.total || !counts.passed)
    return unproven('Standalone target assertions did not complete', expectedMode, extra)
  if (
    !report.cleanup ||
    !['complete', 'failed', 'preserved'].includes(report.cleanup.status) ||
    !report.evidence ||
    !['complete', 'incomplete', 'failed'].includes(report.evidence.status)
  )
    return unproven('Standalone evidence or cleanup result is absent', expectedMode, extra)
  return {
    status: 'passed',
    mode: expectedMode,
    ...extra,
    limits: [
      'Assertions are recorded calls; resource and simulation boundaries are described by mode and metadata',
      'Does not prove customer-machine behavior'
    ]
  }
}

function readXml(context, file) {
  const source = readAttemptFile(context, path.join(context.directory, file))
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error('External XML declarations are not accepted')
  const { DOMParser } = require('@xmldom/xmldom')
  const errors = []
  const doc = new DOMParser({
    errorHandler: {
      warning: (value) => errors.push(value),
      error: (value) => errors.push(value),
      fatalError: (value) => errors.push(value)
    }
  }).parseFromString(source, 'application/xml')
  if (errors.length || doc.documentElement?.tagName !== 'testsuite')
    throw new Error('Malformed target JUnit report')
  return doc.documentElement
}

function assessQtReport(context, { name, file }) {
  const mode = 'ctest-selected-qtest-junit'
  try {
    const selection = readAttemptReport(
      context,
      path.join(context.directory, 'ctest-selection.json')
    )
    if (selection.tests?.length !== 1 || selection.tests[0].name !== name)
      return unproven('CTest discovery is not exactly the selected target', mode)
    const ctest = readXml(context, 'ctest-results.xml')
    const outer = Array.from(ctest.getElementsByTagName('testcase'))
    if (outer.length !== 1 || outer[0].getAttribute('name') !== name)
      return unproven('CTest results do not match the selected target', mode)
    if (
      outer[0].getAttribute('status') !== 'run' ||
      outer[0].getElementsByTagName('skipped').length
    )
      return unproven('CTest did not execute the selected target', mode)
    const suite = readXml(context, name + '.junit.xml')
    readAttemptFile(context, path.join(context.directory, name + '.txt'))
    const all = Array.from(suite.getElementsByTagName('testcase'))
    const cases = all.filter(
      (item) => !/^(initTestCase|cleanupTestCase)(\(|$)/.test(item.getAttribute('name'))
    )
    const counts = { total: cases.length, passed: 0, failed: 0, skipped: 0 }
    for (const item of cases) {
      if (item.getElementsByTagName('failure').length || item.getElementsByTagName('error').length)
        counts.failed++
      else if (item.getElementsByTagName('skipped').length) counts.skipped++
      else counts.passed++
    }
    const failed =
      counts.failed ||
      suite.getElementsByTagName('failure').length ||
      suite.getElementsByTagName('error').length ||
      ctest.getElementsByTagName('failure').length
    if (failed)
      return {
        status: 'failed',
        mode,
        assertions: counts,
        target: file,
        reason: 'CTest/QTest reported failure'
      }
    if (!counts.total || !counts.passed)
      return unproven('QTest contains no completed business cases', mode, { assertions: counts })
    return {
      status: 'passed',
      mode,
      assertions: counts,
      target: file,
      limits: [
        'Counts are completed QTest cases excluding setup/teardown, not QCOMPARE calls',
        'No Electron integration or customer-machine result claimed'
      ]
    }
  } catch (error) {
    return unproven(error.message, mode)
  }
}

module.exports = { assessVitestReport, assessStandaloneReport, assessQtReport }
