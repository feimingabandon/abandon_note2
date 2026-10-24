import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import release from '../scripts/release-candidate.cjs'
import runner from '../scripts/test-runner.cjs'

const roots = []
const source = { commit: 'a'.repeat(40), runId: '123', attempt: 1 }
const root = () => {
  const directory = mkdtempSync(join(tmpdir(), 'abandon-release-evidence-'))
  roots.push(directory)
  return directory
}
const write = (directory, name, value) =>
  writeFileSync(join(directory, name), JSON.stringify(value))
const result = (id, successful = true) => ({
  id,
  status: successful ? 'passed' : 'timeout',
  accepted: successful,
  processResult: { status: successful ? 'passed' : 'timeout' },
  businessResult: { status: 'passed' },
  evidenceResult: { status: 'complete' },
  cleanupResult: { status: 'complete' },
  reportResult: { phase: 'final', status: 'complete' },
  runReportResult: { status: 'complete' }
})
function attempt(directory, name, results) {
  const target = join(directory, name)
  mkdirSync(target)
  write(target, 'summary.json', results)
  write(target, 'completion.json', {
    successful: results.every((item) => item.accepted),
    verifiedPassed: results.filter((item) => item.accepted).length,
    reportGeneration: { runToken: name, generation: results.length, total: results.length }
  })
  write(target, 'run-report-status.json', {
    phase: 'final',
    status: 'complete',
    finalRun: true,
    runToken: name,
    generation: results.length,
    total: results.length
  })
  return target
}
function report(scope) {
  return {
    schema: release.schema,
    kind: 'job-evidence',
    scope,
    ...source,
    successful: true,
    required: ['test'],
    verified: ['test'],
    failures: [],
    runs: [{ directory: 'attempt-1' }]
  }
}
function artifacts(directory) {
  for (const name of release.filesFor('1.5.0')) writeFileSync(join(directory, name), name)
}
function candidate(directory) {
  artifacts(directory)
  return release.assemble({
    directory,
    quality: report('quality'),
    windows: report('windows'),
    version: '1.5.0',
    source
  })
}
afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('release attempt evidence', () => {
  it('accepts complete reports produced by the actual runner', async () => {
    const directory = root()
    const attemptDirectory = runner.createRunDirectory(directory)
    await runner.runJobs(
      [
        {
          id: 'real-fixture',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          resultPolicy: 'required',
          assessResult: () => ({
            status: 'passed',
            mode: 'controlled-fixture',
            assertions: { total: 1, passed: 1, failed: 0, skipped: 0 }
          })
        }
      ],
      { directory: attemptDirectory }
    )
    expect(
      release.collect(directory, {
        scope: 'quality',
        expected: ['real-fixture'],
        jobStatus: 'success',
        source
      }).successful
    ).toBe(true)
  })

  it('writes a failed investigation report even when planning fails before tests start', () => {
    const directory = root()
    write(directory, 'package.json', { version: '1.5.0' })
    const command = fileURLToPath(new URL('../scripts/release-candidate.cjs', import.meta.url))
    const executed = spawnSync(process.execPath, [command, 'collect', 'ci'], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_SHA: source.commit,
        GITHUB_RUN_ID: source.runId,
        GITHUB_RUN_ATTEMPT: '1',
        RELEASE_JOB_STATUS: 'failure'
      }
    })
    expect(executed.status).toBe(1)
    const report = JSON.parse(readFileSync(join(directory, 'tmp/release-evidence/ci.json'), 'utf8'))
    expect(report.successful).toBe(false)
    expect(report.failures[0]).toMatchObject({ jobStatus: 'failure' })
    expect(report.failures[0].reason).toContain('ci-plan.json')
  })
  it('rejects a timed-out process even when every business assertion passed', () => {
    const directory = root()
    attempt(directory, 'first', [result('test', false)])
    const evidence = release.collect(directory, {
      scope: 'quality',
      expected: ['test'],
      jobStatus: 'success',
      source
    })
    expect(evidence.successful).toBe(false)
    expect(evidence.failures).toContainEqual(
      expect.objectContaining({ id: 'test', status: 'timeout' })
    )
  })

  it('retains the first failed attempt after a later successful rerun', () => {
    const directory = root()
    attempt(directory, 'first', [result('test', false)])
    attempt(directory, 'second', [result('test')])
    const evidence = release.collect(directory, {
      scope: 'quality',
      expected: ['test'],
      jobStatus: 'success',
      source
    })
    expect(evidence.verified).toContain('test')
    expect(evidence.successful).toBe(false)
    expect(evidence.failures).toContainEqual(expect.objectContaining({ run: 'first', id: 'test' }))
  })

  it('rejects missing targets, incomplete reports and earlier workflow failures', () => {
    const directory = root()
    const target = attempt(directory, 'first', [result('present')])
    write(target, 'run-report-status.json', { phase: 'final', status: 'complete', finalRun: false })
    const evidence = release.collect(directory, {
      scope: 'quality',
      expected: ['missing'],
      jobStatus: 'failure',
      source
    })
    expect(evidence.successful).toBe(false)
    expect(evidence.failures.map((item) => item.reason).join('\n')).toMatch(
      /Workflow job status: failure/
    )
    expect(evidence.failures.map((item) => item.reason).join('\n')).toMatch(/incomplete/)
    expect(evidence.failures).toContainEqual(expect.objectContaining({ id: 'missing' }))
  })

  it('requires matching report generations rather than a stale completion file', () => {
    const directory = root()
    const target = attempt(directory, 'first', [result('test')])
    write(target, 'completion.json', {
      successful: true,
      verifiedPassed: 1,
      reportGeneration: { runToken: 'old', generation: 1, total: 1 }
    })
    expect(
      release.collect(directory, {
        scope: 'quality',
        expected: ['test'],
        jobStatus: 'success',
        source
      }).successful
    ).toBe(false)
  })

  it('requires all three current builds to remain unchanged after the window tests', () => {
    const directory = root()
    const expected = ['build-native', 'build-capture', 'build-app', 'test']
    const target = attempt(
      directory,
      'first',
      expected.map((id) => result(id))
    )
    const collect = () =>
      release.collect(directory, { scope: 'windows', expected, jobStatus: 'success', source })
    expect(collect().successful).toBe(false)
    const checks = expected
      .slice(0, 3)
      .map((id) => ({ id, verified: true, fingerprint: 'b'.repeat(64) }))
    write(target, 'release-build-continuity.json', {
      schema: 'abandon-release-build-continuity/v1',
      successful: true,
      checks
    })
    expect(collect().successful).toBe(true)
    checks[0].verified = false
    write(target, 'release-build-continuity.json', {
      schema: 'abandon-release-build-continuity/v1',
      successful: true,
      checks
    })
    expect(collect().successful).toBe(false)
  })
})

describe('candidate promotion', () => {
  it('accepts the same installer bytes, commit, version and independent successful gates', () => {
    const directory = root()
    const manifest = candidate(directory)
    expect(
      release.verify(manifest, {
        directory,
        version: '1.5.0',
        commit: source.commit,
        runId: source.runId
      })
    ).toBe(true)
    expect(() =>
      release.verify(manifest, {
        directory,
        version: '1.5.0',
        commit: 'b'.repeat(40),
        runId: source.runId
      })
    ).toThrow('commit or run differs')
  })

  it.each(['changed-installer', 'missing-gate', 'different-attempt', 'extra-artifact'])(
    'refuses candidate corruption: %s',
    (kind) => {
      const directory = root()
      const manifest = candidate(directory)
      if (kind === 'changed-installer')
        writeFileSync(join(directory, manifest.files[0].name), 'tampered')
      if (kind === 'missing-gate') manifest.quality.successful = false
      if (kind === 'different-attempt') manifest.windows.attempt = 2
      if (kind === 'extra-artifact') writeFileSync(join(directory, 'old-setup.exe'), 'old')
      expect(() =>
        release.verify(manifest, {
          directory,
          version: '1.5.0',
          commit: source.commit,
          runId: source.runId
        })
      ).toThrow()
    }
  )

  const run = (id, overrides = {}) => ({
    id,
    head_sha: source.commit,
    event: 'workflow_dispatch',
    head_repository: { full_name: 'owner/repo' },
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    ...overrides
  })
  const select = (runs) =>
    release.selectCandidate({
      github: {
        paginate: vi.fn().mockResolvedValue(runs),
        rest: { actions: { listWorkflowRuns: vi.fn() } }
      },
      owner: 'owner',
      repo: 'repo',
      commit: source.commit
    })

  it('reuses only the newest successful same-repository candidate for the exact SHA', async () => {
    await expect(
      select([
        run(10),
        run(11),
        run(12, { head_sha: 'b'.repeat(40) }),
        run(13, { head_repository: { full_name: 'other/repo' } })
      ])
    ).resolves.toBe('11')
    await expect(select([])).resolves.toBe('')
  })

  it('requires the latest ordinary CI for the release SHA to succeed independently of candidate gates', async () => {
    const check = (runs) =>
      release.requireSuccessfulCi({
        github: {
          paginate: vi.fn().mockResolvedValue(runs),
          rest: { actions: { listWorkflowRuns: vi.fn() } }
        },
        owner: 'owner',
        repo: 'repo',
        commit: source.commit
      })
    await expect(check([run(10)])).resolves.toBe('10')
    await expect(check([run(10), run(11, { conclusion: 'failure' })])).rejects.toThrow(
      'latest ordinary CI'
    )
    await expect(check([run(10, { head_sha: 'b'.repeat(40) })])).rejects.toThrow('exact commit')
    await expect(check([])).rejects.toThrow('latest ordinary CI')
  })

  it.each([
    { conclusion: 'failure' },
    { status: 'in_progress', conclusion: null },
    { run_attempt: 2 }
  ])(
    'does not fall back past a failed, unfinished or retried latest candidate: %j',
    async (overrides) => {
      await expect(select([run(10), run(11, overrides)])).rejects.toThrow()
    }
  )

  it('cannot issue a proof from failed reports or artifacts outside the candidate directory', () => {
    const directory = root()
    artifacts(directory)
    expect(() =>
      release.assemble({
        directory,
        quality: { ...report('quality'), failures: [{ reason: 'first failure' }] },
        windows: report('windows'),
        version: '1.5.0',
        source
      })
    ).toThrow('unresolved')
    const manifest = candidate(directory)
    manifest.files[0].name = '../escape.exe'
    expect(() =>
      release.verify(manifest, {
        directory,
        version: '1.5.0',
        commit: source.commit,
        runId: source.runId
      })
    ).toThrow()
    expect(readFileSync(join(directory, 'latest.yml'), 'utf8')).toBe('latest.yml')
  })
})
