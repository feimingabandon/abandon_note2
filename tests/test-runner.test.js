import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
        job('passes', "console.log('business assertions complete')")
      ],
      opts
    )
    expect(results.map((result) => result.status)).toEqual(['failed', 'blocked', 'passed'])
    expect(results[0].code).toBe(7)
    expect(readFileSync(join(results[0].directory, 'stderr.log'), 'utf8')).toContain(
      'original assertion'
    )
    expect(existsSync(results[0].preservedTemporary)).toBe(true)
    expect(JSON.parse(readFileSync(join(opts.directory, 'summary.json'), 'utf8'))).toHaveLength(3)
  })

  it('classifies missing executables separately from business assertions', async () => {
    const result = await runner.runJob(
      { id: 'missing', command: 'abandon-nonexistent-executable' },
      options()
    )
    expect(result.status).toBe('launch-error')
    expect(result.launchError).toContain('ENOENT')
  })

  it('bounds hanging tests and does not call timeout a pass', async () => {
    const result = await runner.runJob(
      job('hang', 'setInterval(() => {}, 100)', { timeoutMs: 200 }),
      options()
    )
    expect(result.status).toBe('timeout')
  })

  it('removes inherited Electron node mode for GUI and keeps it for database scripts', async () => {
    const opts = { ...options(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    const gui = await runner.runJob(
      job('gui', 'console.log(process.env.ELECTRON_RUN_AS_NODE || "GUI")', { gui: true }),
      opts
    )
    const db = await runner.runJob(
      job('db', 'console.log(process.env.ELECTRON_RUN_AS_NODE)', { electronNode: true }),
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
      'build-app'
    ])
    expect(fullRunner.selectJobs(jobs, [target])[0].requires).toEqual([])
    expect(() => fullRunner.selectJobs(jobs, ['misspelled-test'])).toThrow('Unknown test')
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
    `
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
})
