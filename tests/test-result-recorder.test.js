import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import helper from './helpers/test-result-recorder.cjs'

const { createAssertionRecorder, prepareTestProfile } = helper
const roots = []
const suite = 'tests/controlled-standalone.mjs'
const mode = 'controlled-node-assertions'
const token = '11111111-1111-4111-8111-111111111111'

function attempt() {
  const root = mkdtempSync(join(tmpdir(), 'abandon-result-unit-'))
  roots.push(root)
  const evidence = join(root, 'evidence')
  const temporary = join(root, 'temporary')
  const profile = join(temporary, 'profile')
  mkdirSync(evidence)
  mkdirSync(profile, { recursive: true })
  return {
    root,
    evidence,
    temporary,
    profile,
    env: {
      ABANDON_TEST_RESULT_FILE: join(evidence, 'standalone.json'),
      ABANDON_TEST_RUN_TOKEN: token,
      ABANDON_TEST_EVIDENCE_DIR: evidence,
      ABANDON_TEST_USER_DATA: profile,
      TEMP: temporary
    }
  }
}

const report = (recorder, extra = {}) =>
  recorder.report({ completed: true, cleanup: { status: 'complete' }, ...extra })

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('standalone assertion reports', () => {
  it('counts actual synchronous calls and expected throws once, without replacing expectations', () => {
    const recorder = createAssertionRecorder({ suite, mode, env: {} })
    recorder.assert.equal(2 + 2, 4)
    recorder.assert.ok(true)
    recorder.assert(true)
    recorder.assert.strict.throws(() => {
      throw new Error('expected operation failure')
    }, /expected operation failure/)
    expect(report(recorder).assertions).toEqual({ total: 4, passed: 4, failed: 0, skipped: 0 })
    expect(report(recorder).completed).toBe(true)
    expect(recorder.assert.AssertionError).toBeTypeOf('function')
  })

  it('waits for expected asynchronous rejections before recording a passed assertion', async () => {
    const recorder = createAssertionRecorder({ suite, mode, env: {} })
    let rejectOperation
    const operation = new Promise((_, reject) => {
      rejectOperation = reject
    })
    const checked = recorder.assert.rejects(operation, /expected operation failure/)
    expect(report(recorder).completed).toBe(false)
    expect(report(recorder).assertions).toEqual({ total: 1, passed: 0, failed: 0, skipped: 0 })
    rejectOperation(new Error('expected operation failure'))
    await checked
    expect(report(recorder).assertions).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 })
    expect(report(recorder).completed).toBe(true)
  })

  it('retains synchronous and asynchronous failed assertions even when callers catch them', async () => {
    const recorder = createAssertionRecorder({ suite, mode, env: {} })
    expect(() => recorder.assert.equal(1, 2)).toThrow()
    await expect(recorder.assert.rejects(Promise.resolve('no failure'))).rejects.toThrow()
    expect(report(recorder).assertions).toEqual({ total: 2, passed: 0, failed: 2, skipped: 0 })
    expect(report(recorder).completed).toBe(false)
  })

  it('cannot prove completion with zero assertions or before the script reaches its end', () => {
    const recorder = createAssertionRecorder({ suite, mode, env: {} })
    expect(report(recorder).completed).toBe(false)
    recorder.assert.equal('expected', 'expected')
    expect(report(recorder, { completed: false }).completed).toBe(false)
  })

  it('binds the report to its attempt and keeps evidence and cleanup separate from business counts', () => {
    const state = attempt()
    const recorder = createAssertionRecorder({ suite, mode, env: state.env })
    recorder.assert.equal(1, 1)
    const result = recorder.finish({
      completed: true,
      cleanup: { status: 'failed', error: 'controlled close failure' },
      evidence: { status: 'incomplete', flush: { incomplete: true, reason: 'controlled-timeout' } },
      profileOwnership: 'runner'
    })
    expect(result.completed).toBe(true)
    expect(result.runToken).toBe(token)
    expect(result.assertions).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 })
    expect(result.cleanup.status).toBe('failed')
    expect(result.evidence.status).toBe('incomplete')
    expect(JSON.parse(readFileSync(state.env.ABANDON_TEST_RESULT_FILE, 'utf8'))).toEqual(result)
    expect(() => recorder.assert.ok(true)).toThrow('finalized')
    expect(() => recorder.finish({ cleanup: { status: 'complete' } })).toThrow('finalized')
  })

  it('refuses to overwrite an older attempt report, including an old run token', () => {
    const state = attempt()
    const previous = JSON.stringify({ runToken: 'old-token', completed: true })
    writeFileSync(state.env.ABANDON_TEST_RESULT_FILE, previous)
    expect(() => createAssertionRecorder({ suite, mode, env: state.env })).toThrow('already exists')
    expect(readFileSync(state.env.ABANDON_TEST_RESULT_FILE, 'utf8')).toBe(previous)
  })

  it('requires the managed result file, evidence directory and token together', () => {
    const state = attempt()
    for (const key of [
      'ABANDON_TEST_RESULT_FILE',
      'ABANDON_TEST_RUN_TOKEN',
      'ABANDON_TEST_EVIDENCE_DIR'
    ]) {
      const env = { ...state.env }
      delete env[key]
      expect(() => createAssertionRecorder({ suite, mode, env })).toThrow()
    }
    expect(existsSync(state.env.ABANDON_TEST_RESULT_FILE)).toBe(false)
  })

  it('rejects result files outside the real attempt directory and follows parent junctions', () => {
    const state = attempt()
    const external = attempt()
    const outsideResult = join(external.root, 'outside.json')
    expect(() =>
      createAssertionRecorder({
        suite,
        mode,
        env: { ...state.env, ABANDON_TEST_RESULT_FILE: outsideResult }
      })
    ).toThrow('escapes attempt evidence')
    const alias = join(state.evidence, 'outside-junction')
    symlinkSync(external.root, alias, 'junction')
    expect(() =>
      createAssertionRecorder({
        suite,
        mode,
        env: { ...state.env, ABANDON_TEST_RESULT_FILE: join(alias, 'outside.json') }
      })
    ).toThrow('escapes attempt evidence')
    expect(existsSync(outsideResult)).toBe(false)
  })

  it('rechecks result parents before writing and retains diagnostics when a path changed', () => {
    const state = attempt()
    const external = attempt()
    const parent = join(state.evidence, 'report-parent')
    mkdirSync(parent)
    const file = join(parent, 'standalone.json')
    const recorder = createAssertionRecorder({
      suite,
      mode,
      env: { ...state.env, ABANDON_TEST_RESULT_FILE: file }
    })
    recorder.assert.ok(true)
    writeFileSync(join(state.profile, 'current.jsonl'), '{"event":"current-attempt"}\n')
    rmdirSync(parent)
    symlinkSync(external.root, parent, 'junction')
    expect(() => recorder.finish({ completed: true, cleanup: { status: 'complete' } })).toThrow(
      'escapes attempt evidence'
    )
    expect(existsSync(join(external.root, 'standalone.json'))).toBe(false)
    expect(readFileSync(join(state.profile, 'current.jsonl'), 'utf8')).toContain('current-attempt')
  })

  it('rejects malformed cleanup/evidence states instead of reporting them as complete', () => {
    const recorder = createAssertionRecorder({ suite, mode, env: {} })
    recorder.assert.ok(true)
    expect(() => recorder.report({ completed: true })).toThrow('Cleanup requires')
    expect(() => report(recorder, { cleanup: { status: 'unknown' } })).toThrow('Cleanup requires')
    expect(() => report(recorder, { evidence: { status: 'unknown' } })).toThrow('evidence status')
    expect(() => report(recorder, { profileOwnership: 'unknown' })).toThrow('ownership')
  })
})

describe('standalone profile ownership', () => {
  it('uses only a real descendant of the runner TEMP and does not delete its data', () => {
    const state = attempt()
    const result = prepareTestProfile({ prefix: 'unused-', env: state.env })
    expect(result.directory).toBe(state.profile)
    expect(result.ownership).toBe('runner')
    writeFileSync(join(result.directory, 'current.jsonl'), '{}\n')
    expect(existsSync(join(state.profile, 'current.jsonl'))).toBe(true)
  })

  it('rejects missing ownership markers, missing profiles, the TEMP root and external junctions', () => {
    const state = attempt()
    const external = attempt()
    expect(() =>
      prepareTestProfile({ env: { TEMP: state.temporary, ABANDON_TEST_USER_DATA: state.profile } })
    ).toThrow('requires an attempt result target')
    const env = { ...state.env }
    delete env.ABANDON_TEST_USER_DATA
    expect(() => prepareTestProfile({ env })).toThrow('ABANDON_TEST_USER_DATA')
    expect(() =>
      prepareTestProfile({ env: { ...state.env, ABANDON_TEST_USER_DATA: state.temporary } })
    ).toThrow('escapes owned TEMP')
    const alias = join(state.temporary, 'outside-profile')
    symlinkSync(external.profile, alias, 'junction')
    expect(() =>
      prepareTestProfile({ env: { ...state.env, ABANDON_TEST_USER_DATA: alias } })
    ).toThrow('escapes owned TEMP')
    expect(existsSync(external.profile)).toBe(true)
  })

  it('keeps direct invocation profiles explicitly script-owned', () => {
    const profile = prepareTestProfile({ prefix: 'abandon-direct-result-unit-', env: {} })
    roots.push(profile.directory)
    expect(profile.ownership).toBe('script')
    expect(existsSync(profile.directory)).toBe(true)
  })
})
