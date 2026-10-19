const strictAssert = require('node:assert/strict')
const { existsSync, mkdtempSync, realpathSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')

const assertionMethods = new Set([
  'deepEqual',
  'deepStrictEqual',
  'doesNotMatch',
  'doesNotReject',
  'doesNotThrow',
  'equal',
  'fail',
  'ifError',
  'match',
  'notDeepEqual',
  'notDeepStrictEqual',
  'notEqual',
  'notStrictEqual',
  'ok',
  'rejects',
  'strictEqual',
  'throws'
])

function isInside(root, target, allowRoot = false) {
  const child = relative(root, target)
  return (
    (allowRoot || child !== '') &&
    child !== '..' &&
    !child.startsWith('..' + sep) &&
    !isAbsolute(child)
  )
}

function requiredText(value, label) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim() !== value ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error(label + ' must be a non-empty string without control characters')
  return value
}

function requiredDirectory(value, label) {
  const path = requiredText(value, label)
  if (!isAbsolute(path)) throw new Error(label + ' must be absolute')
  const actual = realpathSync(path)
  if (!statSync(actual).isDirectory()) throw new Error(label + ' must be a directory')
  return actual
}

function managedReportTarget(env) {
  const file = env.ABANDON_TEST_RESULT_FILE
  const token = env.ABANDON_TEST_RUN_TOKEN
  const evidence = env.ABANDON_TEST_EVIDENCE_DIR
  if (!file && !token && !evidence) return null
  requiredText(token, 'ABANDON_TEST_RUN_TOKEN')
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error('Invalid test run token')
  const target = requiredText(file, 'ABANDON_TEST_RESULT_FILE')
  if (!isAbsolute(target)) throw new Error('ABANDON_TEST_RESULT_FILE must be absolute')
  const root = requiredDirectory(evidence, 'ABANDON_TEST_EVIDENCE_DIR')
  const parent = requiredDirectory(dirname(target), 'Result parent')
  if (!isInside(root, parent, true)) throw new Error('Result file escapes attempt evidence')
  if (existsSync(target)) throw new Error('Result file already exists; attempts are immutable')
  return { file: resolve(target), root, token }
}

function prepareTestProfile({ prefix, env = process.env } = {}) {
  const managed = env.ABANDON_TEST_USER_DATA
  const hasReportEnvironment =
    env.ABANDON_TEST_RESULT_FILE || env.ABANDON_TEST_RUN_TOKEN || env.ABANDON_TEST_EVIDENCE_DIR
  if (managed || hasReportEnvironment) {
    if (!managedReportTarget(env))
      throw new Error('Managed profile requires an attempt result target')
    const root = requiredDirectory(env.TEMP, 'TEMP')
    const directory = requiredDirectory(managed, 'ABANDON_TEST_USER_DATA')
    if (!isInside(root, directory)) throw new Error('Managed profile escapes owned TEMP')
    return { directory, ownership: 'runner' }
  }
  requiredText(prefix, 'Temporary profile prefix')
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error('Invalid temporary profile prefix')
  return { directory: mkdtempSync(join(tmpdir(), prefix)), ownership: 'script' }
}

function errorText(error) {
  return error instanceof Error ? error.stack || error.message : String(error)
}

function createAssertionRecorder({ suite, mode, metadata = {}, env = process.env } = {}) {
  requiredText(suite, 'Suite')
  requiredText(mode, 'Mode')
  const target = managedReportTarget(env)
  const counts = { total: 0, passed: 0, failed: 0, skipped: 0 }
  let pending = 0
  let finished = false
  const methods = new Map()
  const invoke = (method, args) => {
    if (finished) throw new Error('Assertions cannot run after the result is finalized')
    counts.total += 1
    let result
    try {
      result = Reflect.apply(method, strictAssert, args)
    } catch (error) {
      counts.failed += 1
      throw error
    }
    if (result && typeof result.then === 'function') {
      pending += 1
      return Promise.resolve(result).then(
        (value) => {
          pending -= 1
          counts.passed += 1
          return value
        },
        (error) => {
          pending -= 1
          counts.failed += 1
          throw error
        }
      )
    }
    counts.passed += 1
    return result
  }
  const assertion = new Proxy((...args) => invoke(strictAssert, args), {
    get(_target, name) {
      if (name === 'strict') return assertion
      if (!assertionMethods.has(name)) return strictAssert[name]
      if (!methods.has(name)) methods.set(name, (...args) => invoke(strictAssert[name], args))
      return methods.get(name)
    }
  })
  function snapshot({ completed = false, cleanup, evidence, error, profileOwnership } = {}) {
    if (!cleanup || !['complete', 'failed', 'preserved'].includes(cleanup.status))
      throw new Error('Cleanup requires complete, failed, or preserved status')
    if (profileOwnership && !['runner', 'script'].includes(profileOwnership))
      throw new Error('Invalid profile ownership')
    if (evidence && !['complete', 'incomplete', 'failed'].includes(evidence.status))
      throw new Error('Invalid evidence status')
    return {
      version: 1,
      suite,
      runToken: target?.token || null,
      mode,
      completed: Boolean(completed && pending === 0 && counts.failed === 0 && counts.total > 0),
      assertions: { ...counts },
      cleanup: { ...cleanup },
      ...(evidence ? { evidence: { ...evidence } } : {}),
      ...(profileOwnership ? { profileOwnership } : {}),
      ...(error ? { error: errorText(error) } : {}),
      metadata: { ...metadata }
    }
  }
  function finish(options) {
    if (finished) throw new Error('Result has already been finalized')
    const result = snapshot(options)
    const content = JSON.stringify(result) + '\n'
    if (target) {
      // Recheck real parents immediately before the exclusive write. No caller
      // supplied report path may overwrite another attempt or escape its owner.
      const parent = requiredDirectory(dirname(target.file), 'Result parent')
      if (!isInside(target.root, parent, true))
        throw new Error('Result file escapes attempt evidence')
      writeFileSync(target.file, content, { flag: 'wx' })
    } else process.stdout.write(content)
    finished = true
    return result
  }
  return { assert: assertion, report: snapshot, finish }
}

module.exports = { createAssertionRecorder, prepareTestProfile }
