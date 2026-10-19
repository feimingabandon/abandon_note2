import fs, {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  linkSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import runner from '../scripts/test-runner.cjs'
import fullRunner from '../scripts/run-full-tests.cjs'
import manifest from '../scripts/test-manifest.cjs'

const roots = []
const options = () => {
  const directory = mkdtempSync(join(tmpdir(), 'abandon-runner-unit-'))
  roots.push(directory)
  return { directory }
}
const job = (id, code, extra = {}) => ({
  id,
  command: process.execPath,
  args: ['-e', code],
  ...extra
})
const proven = {
  resultPolicy: 'required',
  assessResult: ({ stdout }) => ({
    status: stdout.includes('business assertions complete') ? 'passed' : 'unproven',
    mode: 'controlled-fixture',
    assertions: {
      total: 1,
      passed: stdout.includes('business assertions complete') ? 1 : 0,
      failed: 0,
      skipped: 0
    }
  })
}
const fixtureRequire = createRequire(import.meta.url)
const withReportWriteFailure = async (rejectWrite, callback) => {
  const modulePath = fixtureRequire.resolve('../scripts/test-runner.cjs')
  const previousModule = fixtureRequire.cache[modulePath]
  const originalWrite = fs.writeFileSync
  fs.writeFileSync = function (file, ...args) {
    const error = rejectWrite(String(file), args[0])
    if (error) throw new Error(error)
    return originalWrite.call(this, file, ...args)
  }
  delete fixtureRequire.cache[modulePath]
  try {
    return await callback(fixtureRequire(modulePath))
  } finally {
    fs.writeFileSync = originalWrite
    delete fixtureRequire.cache[modulePath]
    if (previousModule) fixtureRequire.cache[modulePath] = previousModule
  }
}
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('test execution evidence', () => {
  it('continues after failures, persists output and blocks only dependants', async () => {
    const opts = options()
    const results = await runner.runJobs(
      [
        job('fails', "console.error('original assertion'); process.exit(7)"),
        job('blocked', "throw Error('must not run')", { requires: ['fails'] }),
        job('passes', "console.log('business assertions complete')", proven)
      ],
      opts
    )
    expect(results.map((result) => result.status)).toEqual(['failed', 'blocked', 'passed'])
    expect(results[0].code).toBe(7)
    expect(runner.isResultSuccessful(results[2])).toBe(true)
    expect(results[1].businessResult.status).toBe('not-run')
    expect(existsSync(join(results[1].directory, 'result.json'))).toBe(true)
    expect(readFileSync(join(results[0].directory, 'stderr.log'), 'utf8')).toContain(
      'original assertion'
    )
    expect(existsSync(results[0].preservedTemporary)).toBe(true)
    expect(JSON.parse(readFileSync(join(opts.directory, 'summary.json'), 'utf8'))).toHaveLength(3)
    expect(readJson(join(opts.directory, 'run-report-status.json'))).toMatchObject({
      phase: 'final',
      status: 'complete',
      finalRun: true,
      generation: 3,
      total: 3
    })
  })

  it('classifies missing executables separately from business assertions', async () => {
    const result = await runner.runJob(
      { id: 'missing', command: 'abandon-nonexistent-executable' },
      options()
    )
    expect(result.status).toBe('launch-error')
    expect(result.launchError).toContain('ENOENT')
    expect(result.businessResult.status).toBe('not-run')
    expect(result.accepted).toBe(false)
  })

  it('bounds hanging tests and does not call timeout a pass', async () => {
    const result = await runner.runJob(
      job('hang', 'setInterval(() => {}, 100)', { timeoutMs: 200 }),
      options()
    )
    expect(result.status).toBe('timeout')
    expect(result.processResult.timedOut).toBe(true)
    expect(existsSync(result.preservedTemporary)).toBe(true)
  })

  it('removes inherited Electron node mode for GUI and keeps it for database scripts', async () => {
    const opts = { ...options(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    const gui = await runner.runJob(
      job('gui', 'console.log(process.env.ELECTRON_RUN_AS_NODE || "GUI")', {
        gui: true,
        resultKind: 'check'
      }),
      opts
    )
    const db = await runner.runJob(
      job('db', 'console.log(process.env.ELECTRON_RUN_AS_NODE)', {
        electronNode: true,
        resultKind: 'check'
      }),
      opts
    )
    expect(readFileSync(join(gui.directory, 'stdout.log'), 'utf8').trim()).toBe('GUI')
    expect(readFileSync(join(db.directory, 'stdout.log'), 'utf8').trim()).toBe('1')
  })

  it('includes every registered standalone script once, excluding helpers', () => {
    const jobs = fullRunner.createJobs()
    const scripts = jobs
      .map((entry) => entry.id)
      .filter((id) => id.startsWith('tests/'))
      .sort()
    expect(new Set(jobs.map((entry) => entry.id)).size).toBe(jobs.length)
    expect(scripts).toEqual(
      manifest.registeredMjsFiles.filter((file) => !manifest.helperFiles.includes(file)).sort()
    )
  })

  it('keeps selected build dependencies during retests and rejects unknown IDs', () => {
    const jobs = fullRunner.createJobs()
    const target = 'tests/window-control-drag-electron.mjs'
    expect(fullRunner.selectJobs(jobs, ['build-app', target]).at(-1).requires).toEqual([
      'build-native',
      'build-capture',
      'build-app'
    ])
    expect(fullRunner.selectJobs(jobs, [target]).map((job) => job.id)).toEqual([
      'build-native',
      'build-capture',
      'build-app',
      target
    ])
    expect(() => fullRunner.selectJobs(jobs, ['misspelled-test'])).toThrow('Unknown test')
  })

  it('builds and tests capture before GUI jobs and preserves native evidence', () => {
    const jobs = fullRunner.createJobs()
    const capture = jobs.find((entry) => entry.id === 'build-capture')
    expect(capture.args).toContain('native_capture/build.ps1')
    expect(capture.args).toContain('-Test')
    expect(capture.args).toContain('-TestName')
    expect(capture.prepare({ directory: 'current-attempt' }).args).toContain('current-attempt')
    for (const gui of jobs.filter((entry) => entry.gui)) {
      expect(gui.requires).toContain('build-capture')
      expect(jobs.indexOf(gui)).toBeGreaterThan(jobs.indexOf(capture))
    }
    const target = 'tests/capture-business-electron.mjs'
    expect(fullRunner.selectJobs(jobs, ['build-capture', target]).at(-1).requires).toEqual([
      'build-native',
      'build-capture',
      'build-app'
    ])
  })

  it('archives successful application diagnostics before removing temporary caches', async () => {
    const result = await runner.runJob(
      job(
        'diagnostics',
        `
      const fs = require('node:fs')
      const path = require('node:path')
      fs.writeFileSync(path.join(process.env.TEMP, 'app.jsonl'), '{"scope":"business"}\\n')
      console.log(process.env.TEMP)
    `,
        { resultKind: 'check' }
      ),
      options()
    )
    expect(result.status).toBe('passed')
    expect(readFileSync(join(result.directory, 'diagnostics', 'app.jsonl'), 'utf8')).toContain(
      'business'
    )
    const temporary = readFileSync(join(result.directory, 'stdout.log'), 'utf8').trim()
    expect(existsSync(temporary)).toBe(false)
  })

  it('retains legacy zero-exit evidence without approving it as a migration gate', async () => {
    const result = await runner.runJob(job('legacy', "console.log('old useful output')"), options())
    expect(result.status).toBe('passed')
    expect(result.processResult).toMatchObject({ status: 'passed', code: 0, timedOut: false })
    expect(result.businessResult).toMatchObject({ status: 'unproven', mode: 'legacy-process-exit' })
    expect(result.accepted).toBe(false)
    expect(existsSync(result.preservedTemporary)).toBe(true)
    expect(runner.summarizeResults([result])).toMatchObject({
      total: 1,
      verifiedPassed: 0,
      legacyUnproven: 1,
      successful: false
    })
  })

  it.each([
    ['no assertions', { total: 0, passed: 0, failed: 0, skipped: 0 }],
    ['all skipped', { total: 3, passed: 0, failed: 0, skipped: 3 }],
    ['contradictory counts', { total: 0, passed: 1, failed: 0, skipped: 0 }],
    ['no completed success', { total: 1, passed: 0, failed: 0, skipped: 0 }],
    ['missing passed count', { total: 1, failed: 0, skipped: 0 }]
  ])('does not approve zero exit with %s', async (_, assertions) => {
    const result = await runner.runJob(
      job('empty-proof', '', {
        resultPolicy: 'required',
        assessResult: () => ({ status: 'passed', mode: 'controlled-fixture', assertions })
      }),
      options()
    )
    expect(result.status).toBe('unverified')
    expect(result.businessResult.status).toBe('unproven')
    expect(result.processResult.code).toBe(0)
    expect(result.accepted).toBe(false)
  })

  it('records required missing adapters and complete-skipped reports without passing', async () => {
    const opts = options()
    const missing = await runner.runJob(
      job('missing-adapter', '', { resultPolicy: 'required' }),
      opts
    )
    const skipped = await runner.runJob(
      job('skipped-report', '', {
        resultPolicy: 'required',
        assessResult: () => ({ status: 'skipped', reason: 'No applicable business assertions' })
      }),
      opts
    )
    expect(missing.status).toBe('unverified')
    expect(missing.businessResult.mode).toBe('missing-adapter')
    expect(skipped.status).toBe('unverified')
    expect(skipped.businessResult.status).toBe('skipped')
    expect(runner.summarizeResults([missing, skipped]).unverified).toBe(2)
  })

  it('keeps raw process success separate from explicit assertion failure', async () => {
    const result = await runner.runJob(
      job('assertion-failure', '', {
        resultPolicy: 'required',
        assessResult: () => ({ status: 'failed', assertions: { total: 1, passed: 0, failed: 1 } })
      }),
      options()
    )
    expect(result.code).toBe(0)
    expect(result.processResult.status).toBe('passed')
    expect(result.status).toBe('failed')
    expect(runner.summarizeResults([result]).failed).toBe(1)
    expect(existsSync(result.preservedTemporary)).toBe(true)
  })

  it('does not invent assertion counts for explicit builds and checks', async () => {
    const result = await runner.runJob(job('check', '', { resultKind: 'check' }), options())
    expect(runner.isResultSuccessful(result)).toBe(true)
    expect(result.businessResult.mode).toBe('process-check')
    expect(result.businessResult).not.toHaveProperty('assertions')
    expect(runner.summarizeResults([result]).successful).toBe(true)
    expect(runner.summarizeResults([]).successful).toBe(false)
  })

  it('requires fresh declared reports and preserves stale or missing attempts', async () => {
    const opts = options()
    const cwd = opts.directory
    writeFileSync(join(cwd, 'old.json'), '{"old":true}')
    utimesSync(join(cwd, 'old.json'), new Date(2000, 0), new Date(2000, 0))
    const missing = await runner.runJob(
      job('missing-report', "console.log('business assertions complete')", {
        ...proven,
        requiredArtifacts: ['missing.json']
      }),
      { ...opts, cwd }
    )
    const stale = await runner.runJob(
      job('stale-report', "console.log('business assertions complete')", {
        ...proven,
        requiredArtifacts: ['old.json']
      }),
      { ...opts, cwd }
    )
    const fresh = await runner.runJob(
      job(
        'fresh-report',
        "require('node:fs').writeFileSync('fresh.json', '{\"new\":true}'); console.log('business assertions complete')",
        { ...proven, requiredArtifacts: ['fresh.json'] }
      ),
      { ...opts, cwd }
    )
    expect(missing.evidenceResult).toMatchObject({ status: 'missing', missing: ['missing.json'] })
    expect(stale.evidenceResult).toMatchObject({ status: 'missing', stale: ['old.json'] })
    for (const result of [missing, stale]) {
      expect(result.status).toBe('unverified')
      expect(result.accepted).toBe(false)
      expect(existsSync(result.preservedTemporary)).toBe(true)
    }
    expect(runner.isResultSuccessful(fresh)).toBe(true)
    expect(readFileSync(join(fresh.directory, 'artifacts', 'fresh.json'), 'utf8')).toContain('new')
  })

  it('rejects external, ADS and linked evidence paths before reading their contents', async () => {
    const opts = options()
    const external = options().directory
    writeFileSync(join(external, 'secret.json'), '{"external":true}')
    mkdirSync(join(opts.directory, 'linked-parent'))
    symlinkSync(
      external,
      join(opts.directory, 'linked-parent', 'outside'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    for (const artifact of [
      '../escape.json',
      'secret.json:stream',
      'linked-parent/outside/secret.json'
    ]) {
      const result = await runner.runJob(
        job('unsafe-report', "console.log('business assertions complete')", {
          ...proven,
          requiredArtifacts: [artifact]
        }),
        { ...opts, cwd: opts.directory }
      )
      expect(result.evidenceResult.status).toBe('collection-failed')
      expect(result.evidenceResult.errors).toHaveLength(1)
      expect(result.evidenceResult.copied).toEqual([])
      expect(result.accepted).toBe(false)
    }
    expect(readFileSync(join(external, 'secret.json'), 'utf8')).toContain('external')
  })

  it('does not scan or clean a temporary root replaced by an external junction', async () => {
    const opts = options()
    const external = options().directory
    writeFileSync(join(external, 'outside.jsonl'), '{"external":"preserve"}')
    const result = await runner.runJob(
      job('replaced-temporary', '', {
        resultPolicy: 'required',
        prepare: ({ temporary }) => {
          rmSync(temporary, { recursive: true, force: true })
          symlinkSync(external, temporary, process.platform === 'win32' ? 'junction' : 'dir')
        },
        assessResult: () => ({
          status: 'passed',
          assertions: { total: 1, passed: 1, failed: 0, skipped: 0 }
        })
      }),
      opts
    )
    expect(result.evidenceResult.status).toBe('collection-failed')
    expect(result.evidenceResult.copied).toEqual([])
    expect(result.cleanupResult.runnerStatus).toBe('pending')
    expect(result.accepted).toBe(false)
    expect(readFileSync(join(external, 'outside.jsonl'), 'utf8')).toContain('preserve')
  })

  it('refuses linked diagnostic destinations and never overwrites external evidence', async () => {
    const opts = options()
    const external = options().directory
    writeFileSync(join(external, 'app.jsonl'), 'external original')
    const result = await runner.runJob(
      job(
        'linked-destination',
        `
      require('node:fs').writeFileSync(require('node:path').join(process.env.TEMP, 'app.jsonl'), 'new owned output')
      console.log('business assertions complete')
    `,
        {
          ...proven,
          prepare: ({ directory }) => {
            symlinkSync(
              external,
              join(directory, 'diagnostics'),
              process.platform === 'win32' ? 'junction' : 'dir'
            )
          }
        }
      ),
      opts
    )
    expect(result.evidenceResult.status).toBe('collection-failed')
    expect(result.accepted).toBe(false)
    expect(readFileSync(join(external, 'app.jsonl'), 'utf8')).toBe('external original')
    expect(existsSync(result.preservedTemporary)).toBe(true)
  })

  it('writes a recovery report in an owned sibling if a case root is replaced', async () => {
    const opts = options()
    const external = options().directory
    const result = await runner.runJob(
      job('replaced-case', "throw Error('must not spawn')", {
        prepare: ({ directory }) => {
          rmSync(directory, { recursive: true, force: true })
          symlinkSync(external, directory, process.platform === 'win32' ? 'junction' : 'dir')
        }
      }),
      opts
    )
    expect(result.status).toBe('runner-error')
    expect(result.evidenceResult.status).toBe('collection-failed')
    expect(result.accepted).toBe(false)
    expect(result.recoveryReport.startsWith(opts.directory)).toBe(true)
    expect(JSON.parse(readFileSync(result.recoveryReport, 'utf8')).accepted).toBe(false)
    expect(existsSync(join(external, 'stdout.log'))).toBe(false)
    expect(existsSync(join(external, 'result.json'))).toBe(false)
  })

  it('refuses hard-linked result destinations without modifying external files', async () => {
    const opts = options()
    const external = options().directory
    const original = join(external, 'report.json')
    writeFileSync(original, 'external original')
    const result = await runner.runJob(
      job('linked-result', '', {
        resultKind: 'check',
        prepare: ({ directory }) => linkSync(original, join(directory, 'result.json'))
      }),
      opts
    )
    expect(result.accepted).toBe(false)
    expect(result.evidenceResult.status).toBe('collection-failed')
    expect(readFileSync(original, 'utf8')).toBe('external original')
    expect(existsSync(result.preservedTemporary)).toBe(true)
    expect(JSON.parse(readFileSync(result.recoveryReport, 'utf8')).accepted).toBe(false)
  })

  it('separates cleanup failure and retains diagnostic evidence plus the owned directory', async () => {
    const opts = options()
    const result = await runner.runJob(
      job('cleanup-failure', "console.log('business assertions complete')", proven),
      {
        ...opts,
        cleanupTemporary: (temporary) => {
          expect(temporary.startsWith(opts.directory)).toBe(true)
          throw new Error('controlled cleanup denied')
        }
      }
    )
    expect(result.businessResult.status).toBe('passed')
    expect(result.evidenceResult.status).toBe('complete')
    expect(result.cleanupResult).toMatchObject({
      status: 'failed',
      reason: 'controlled cleanup denied'
    })
    expect(result.status).toBe('unverified')
    expect(existsSync(result.preservedTemporary)).toBe(true)
    expect(JSON.parse(readFileSync(join(result.directory, 'result.json'), 'utf8')).accepted).toBe(
      false
    )
  })

  it.each([
    ['script cleanup', { scriptCleanup: { status: 'failed', reason: 'database close failed' } }],
    [
      'script evidence',
      { scriptEvidence: { status: 'incomplete', reason: 'diagnostic flush timed out' } }
    ]
  ])('keeps passing assertions separate from incomplete %s', async (_, details) => {
    const result = await runner.runJob(
      job('script-resource-result', '', {
        resultPolicy: 'required',
        assessResult: () => ({
          status: 'passed',
          mode: 'controlled-fixture',
          assertions: { total: 1, passed: 1, failed: 0, skipped: 0 },
          ...details
        })
      }),
      options()
    )
    expect(result.businessResult.status).toBe('passed')
    expect(result.accepted).toBe(false)
    expect(result.status).toBe('unverified')
    expect(result.cleanupResult.runnerStatus).toBe('pending')
    if (details.scriptCleanup) expect(result.cleanupResult.status).toBe('failed')
    if (details.scriptEvidence) expect(result.evidenceResult.status).toBe('incomplete')
    expect(existsSync(result.preservedTemporary)).toBe(true)
  })

  it('never overwrites the first failure when retrying IDs or sanitized-name collisions', async () => {
    const opts = options()
    const first = await runner.runJob(
      job('same/id', "console.error('first failure'); process.exit(9)"),
      opts
    )
    const retry = await runner.runJob(
      job('same/id', "console.log('business assertions complete')", proven),
      opts
    )
    const collision = await runner.runJob(
      job('same_id', "console.log('business assertions complete')", proven),
      opts
    )
    expect(new Set([first.directory, retry.directory, collision.directory]).size).toBe(3)
    expect(readFileSync(join(first.directory, 'stderr.log'), 'utf8')).toContain('first failure')
    expect(JSON.parse(readFileSync(join(first.directory, 'result.json'), 'utf8')).code).toBe(9)
    expect(existsSync(first.preservedTemporary)).toBe(true)
    expect(retry.accepted).toBe(true)
  })

  it('blocks unproven dependencies, records preflight blockers and continues independent checks', async () => {
    const opts = options()
    const results = await runner.runJobs(
      [
        job('legacy-dependency', ''),
        job('dependent', "throw Error('must not start')", { requires: ['legacy-dependency'] }),
        job('preflight', "throw Error('must not start')", {
          blockedReason: 'Build provenance unavailable'
        }),
        job('independent', '', { resultKind: 'check' })
      ],
      opts
    )
    expect(results.map((result) => result.status)).toEqual([
      'passed',
      'blocked',
      'blocked',
      'passed'
    ])
    expect(results[1].reason).toContain('legacy-dependency')
    expect(results[2].reason).toBe('Build provenance unavailable')
    expect(results[2].processResult.status).toBe('not-run')
    expect(results[3].accepted).toBe(true)
    expect(runner.summarizeResults(results)).toMatchObject({
      verifiedPassed: 1,
      legacyUnproven: 1,
      blocked: 2,
      successful: false
    })
  })

  it('prepares attempt-specific args and preserves runner environment ownership', async () => {
    const opts = options()
    let preparedDirectory
    const result = await runner.runJob(
      job('prepared', "throw Error('old args')", {
        resultKind: 'check',
        prepare: async ({ directory }) => {
          preparedDirectory = directory
          return {
            args: ['-e', 'console.log(process.env.TEMP); console.log(process.env.PREPARED_FLAG)'],
            env: { TEMP: 'must-not-use', PREPARED_FLAG: 'prepared', PRIVATE_TOKEN: 'not-in-report' }
          }
        }
      }),
      opts
    )
    expect(result.directory).toBe(preparedDirectory)
    expect(result.accepted).toBe(true)
    expect(readFileSync(join(result.directory, 'stdout.log'), 'utf8')).toContain(
      join(result.directory, 'temp-')
    )
    expect(readFileSync(join(result.directory, 'stdout.log'), 'utf8')).toContain('prepared')
    expect(readFileSync(join(result.directory, 'result.json'), 'utf8')).not.toContain(
      'not-in-report'
    )
  })

  it('keeps preparation errors and bounded adapter errors distinct from launch errors', async () => {
    const opts = options()
    const preparation = await runner.runJob(
      job('prepare-error', "throw Error('must not start')", {
        prepare: () => {
          throw new Error('controlled preparation error')
        }
      }),
      opts
    )
    const assessment = await runner.runJob(
      job('adapter-timeout', '', {
        resultPolicy: 'required',
        assessmentTimeoutMs: 30,
        assessResult: () => new Promise(() => {})
      }),
      opts
    )
    expect(preparation.status).toBe('runner-error')
    expect(preparation.launchError).toBeNull()
    expect(preparation.businessResult.status).toBe('not-run')
    expect(assessment.status).toBe('unverified')
    expect(assessment.businessResult.reason).toContain('timed out')
    expect(existsSync(assessment.preservedTemporary)).toBe(true)
  })

  it('refuses linked run summaries, reports evidence failure and blocks only dependants', async () => {
    const opts = options()
    const external = options().directory
    const protectedFile = join(external, 'protected-summary.json')
    writeFileSync(protectedFile, 'outside evidence must remain')
    const results = await runner.runJobs(
      [
        job('summary-link', '', {
          resultKind: 'check',
          prepare: () => linkSync(protectedFile, join(opts.directory, 'summary.json'))
        }),
        job('summary-dependant', "throw Error('must not start')", { requires: ['summary-link'] }),
        job('summary-independent', "console.log('independent completed')", { resultKind: 'check' })
      ],
      opts
    )
    expect(readFileSync(protectedFile, 'utf8')).toBe('outside evidence must remain')
    expect(results[0].accepted).toBe(false)
    expect(results[0].evidenceResult.status).toBe('collection-failed')
    expect(results[0].summaryError).toContain('Linked evidence destination')
    expect(readJson(results[0].reportResult.authoritativePath).accepted).toBe(false)
    expect(results[0].runReportResult).toMatchObject({
      status: 'recovered',
      primaryStatus: 'failed'
    })
    expect(readJson(results[0].runReportResult.summaryPath)[0].accepted).toBe(false)
    expect(results[1].processResult.status).toBe('not-run')
    expect(results[2].processResult.status).toBe('passed')
    expect(runner.summarizeResults(results).successful).toBe(false)
  })

  it('rejects before writing final-case recovery and marks the old primary provisional', async () => {
    const opts = options()
    let primaryWrites = 0
    await withReportWriteFailure(
      (file) => {
        if (
          file.startsWith(opts.directory) &&
          basename(file) === 'result.json' &&
          !file.includes('runner-report-')
        ) {
          if (++primaryWrites === 2) return 'controlled final case report denial'
        }
      },
      async (isolatedRunner) => {
        const result = await isolatedRunner.runJob(
          job('final-case-write', '', { resultKind: 'check', resultPolicy: 'required' }),
          opts
        )
        const primary = readJson(join(result.directory, 'result.json'))
        const recovery = readJson(result.reportResult.authoritativePath)
        expect(primary).toMatchObject({ accepted: false, reportResult: { phase: 'provisional' } })
        expect(result).toMatchObject({
          accepted: false,
          status: 'unverified',
          processResult: { status: 'passed' },
          businessResult: { status: 'passed' },
          cleanupResult: { status: 'complete' },
          reportResult: { phase: 'final', status: 'recovered', primaryUsable: false }
        })
        expect(recovery).toMatchObject({
          accepted: false,
          status: 'unverified',
          reportResult: result.reportResult,
          evidenceResult: result.evidenceResult
        })
        expect(isolatedRunner.isResultSuccessful(recovery)).toBe(false)
      }
    )
  })

  it.each(['summary', 'completion', 'status-commit'])(
    'publishes a consistent rejected run after primary %s denial',
    async (mode) => {
      const opts = options()
      await withReportWriteFailure(
        (file, body) => {
          if (mode === 'status-commit') {
            if (
              file === join(opts.directory, 'run-report-status.json') &&
              JSON.parse(body).status === 'complete'
            )
              return 'controlled status commit denial'
          } else if (file === join(opts.directory, mode + '.json'))
            return 'controlled ' + mode + ' denial'
        },
        async (isolatedRunner) => {
          const [result] = await isolatedRunner.runJobs(
            [job('run-report-write', '', { resultKind: 'check', resultPolicy: 'required' })],
            opts
          )
          expect(result).toMatchObject({
            accepted: false,
            status: 'unverified',
            processResult: { status: 'passed' },
            businessResult: { status: 'passed' },
            evidenceResult: { status: 'collection-failed' },
            runReportResult: {
              phase: 'final',
              status: 'recovered',
              primaryStatus: 'failed',
              finalRun: true
            }
          })
          expect(readJson(result.reportResult.authoritativePath)).toMatchObject({
            accepted: false,
            status: 'unverified',
            runReportResult: result.runReportResult
          })
          const marker = readJson(join(opts.directory, 'run-report-status.json'))
          expect(marker).toMatchObject({
            status: 'recovery-required',
            primaryStatus: 'failed',
            summaryPath: null,
            completionPath: null,
            recoveryStatusPath: result.runReportResult.statusPath
          })
          expect(readJson(result.runReportResult.statusPath)).toEqual(result.runReportResult)
          expect(readJson(result.runReportResult.summaryPath)[0]).toMatchObject({
            accepted: false,
            status: 'unverified'
          })
          expect(readJson(result.runReportResult.completionPath)).toMatchObject({
            successful: false,
            verifiedPassed: 0,
            unverified: 1,
            reportGeneration: { runToken: result.runReportResult.runToken, generation: 1, total: 1 }
          })
          if (mode !== 'summary')
            expect(readJson(join(opts.directory, 'summary.json'))[0].accepted).toBe(true)
          expect(isolatedRunner.summarizeResults([result]).successful).toBe(false)
        }
      )
    }
  )

  it('reports the case unavailable when both primary and recovery writes are denied', async () => {
    const opts = options()
    await withReportWriteFailure(
      (file) =>
        file.startsWith(opts.directory) && basename(file) === 'result.json'
          ? 'controlled all case reports denial'
          : null,
      async (isolatedRunner) => {
        const result = await isolatedRunner.runJob(
          job('all-case-reports', '', { resultKind: 'check', resultPolicy: 'required' }),
          opts
        )
        expect(result).toMatchObject({
          accepted: false,
          status: 'unverified',
          reportResult: {
            phase: 'final',
            status: 'unavailable',
            primaryUsable: false,
            authoritativePath: null
          }
        })
        expect(result.evidenceError).toContain('result.json: controlled all case reports denial')
        expect(result.evidenceError).toContain(
          'recovery report: controlled all case reports denial'
        )
        expect(existsSync(result.preservedTemporary)).toBe(true)
        expect(existsSync(join(result.directory, 'stdout.log'))).toBe(true)
        expect(existsSync(result.recoveryReport)).toBe(false)
      }
    )
  })

  it('does not claim a usable pair when primary and recovery summaries both fail', async () => {
    const opts = options()
    await withReportWriteFailure(
      (file) =>
        file.startsWith(opts.directory) && basename(file) === 'summary.json'
          ? 'controlled all summaries denial'
          : null,
      async (isolatedRunner) => {
        const [result] = await isolatedRunner.runJobs(
          [job('all-run-reports', '', { resultKind: 'check', resultPolicy: 'required' })],
          opts
        )
        expect(result).toMatchObject({
          accepted: false,
          status: 'unverified',
          runReportResult: {
            status: 'unavailable',
            primaryStatus: 'failed',
            summaryPath: null,
            completionPath: null
          }
        })
        expect(result.evidenceError).toContain('Run report: controlled all summaries denial')
        expect(result.evidenceError).toContain(
          'Run recovery report: controlled all summaries denial'
        )
        expect(readJson(result.reportResult.authoritativePath).runReportResult.status).toBe(
          'unavailable'
        )
        expect(readJson(result.runReportResult.statusPath).status).toBe('unavailable')
        expect(isolatedRunner.summarizeResults([result]).successful).toBe(false)
      }
    )
  })

  it('blocks a dependant after transient report failure and still verifies an independent check', async () => {
    const opts = options()
    let summaryWrites = 0
    await withReportWriteFailure(
      (file) =>
        file === join(opts.directory, 'summary.json') && ++summaryWrites === 1
          ? 'controlled first summary denial'
          : null,
      async (isolatedRunner) => {
        const results = await isolatedRunner.runJobs(
          [
            job('report-dependency', '', { resultKind: 'check' }),
            job('report-dependant', "throw Error('must not run')", {
              requires: ['report-dependency']
            }),
            job('report-independent', '', { resultKind: 'check' })
          ],
          opts
        )
        expect(results[0].accepted).toBe(false)
        expect(results[1].processResult.status).toBe('not-run')
        expect(results[2].accepted).toBe(true)
        expect(readJson(join(opts.directory, 'run-report-status.json'))).toMatchObject({
          phase: 'final',
          status: 'complete',
          finalRun: true,
          generation: 3,
          total: 3
        })
        expect(isolatedRunner.summarizeResults(results)).toMatchObject({
          verifiedPassed: 1,
          unverified: 1,
          blocked: 1,
          successful: false
        })
      }
    )
  })

  it('bounds required output failures without waiting forever for stream finish', async () => {
    const result = await runner.runJob(
      job('log-failure', "console.log('write'); setInterval(() => {}, 100)", {
        resultPolicy: 'required',
        timeoutMs: 2000
      }),
      {
        ...options(),
        writeLog: () => {
          throw new Error('controlled log write error')
        }
      }
    )
    expect(result.accepted).toBe(false)
    expect(result.evidenceResult.status).toBe('collection-failed')
    expect(result.evidenceError).toContain('controlled log write error')
    expect(existsSync(result.preservedTemporary)).toBe(true)
    expect(result.durationMs).toBeLessThan(7000)
  })
})
