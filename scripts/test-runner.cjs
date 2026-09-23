const { spawn } = require('node:child_process')
const {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { dirname, join, resolve } = require('node:path')

// Keep each attempt immutable. A retest must never overwrite first-failure evidence.
function createRunDirectory(root = resolve('tmp/test-runs')) {
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, new Date().toISOString().replaceAll(/[:.]/g, '-') + '-'))
}

async function runJob(job, { directory, cwd = process.cwd(), env = process.env } = {}) {
  const caseDirectory = join(directory, job.id.replaceAll(/[^\w.-]/g, '_'))
  mkdirSync(caseDirectory, { recursive: true })
  const temporary = mkdtempSync(join(caseDirectory, 'temp-'))
  const profile = join(temporary, 'profile')
  mkdirSync(profile)
  const childEnv = { ...env, TEMP: temporary, TMP: temporary, TMPDIR: temporary }
  delete childEnv.ELECTRON_RUN_AS_NODE
  delete childEnv.ABANDON_TEST_USER_DATA
  if (job.electronNode) childEnv.ELECTRON_RUN_AS_NODE = '1'
  if (job.gui) childEnv.ABANDON_TEST_USER_DATA = profile
  const stdout = createWriteStream(join(caseDirectory, 'stdout.log'))
  const stderr = createWriteStream(join(caseDirectory, 'stderr.log'))
  const startedAt = new Date().toISOString()
  const started = Date.now()
  let timedOut = false
  let launchError = null
  const child = spawn(job.command, job.args || [], {
    cwd,
    env: childEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.pipe(stdout)
  child.stderr.pipe(stderr)
  const timeout = setTimeout(() => {
    timedOut = true
    // Only this runner's still-owned child tree, never a process-name-wide kill.
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => child.kill())
    } else child.kill('SIGKILL')
  }, job.timeoutMs || 180_000)
  const completion = await new Promise((done) => {
    child.on('error', (error) => {
      launchError = error.message
    })
    child.on('close', (code, signal) => done({ code, signal }))
  })
  clearTimeout(timeout)
  await Promise.all(
    [stdout, stderr].map(
      (stream) =>
        new Promise((done) => {
          if (stream.writableFinished) done()
          else stream.on('finish', done)
        })
    )
  )
  const result = {
    id: job.id,
    command: job.command,
    args: job.args || [],
    startedAt,
    durationMs: Date.now() - started,
    ...completion,
    launchError,
    status: timedOut
      ? 'timeout'
      : launchError
        ? 'launch-error'
        : completion.code === 0
          ? 'passed'
          : 'failed',
    directory: caseDirectory
  }
  // Preserve diagnostic evidence even for successful tests before clearing caches.
  // Some historical scripts still remove their own userData; stdout/stderr always remain.
  try {
    for (const file of readdirSync(temporary, { recursive: true })) {
      if (!file.endsWith('.jsonl')) continue
      const target = join(caseDirectory, 'diagnostics', file)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(temporary, file), target)
    }
    for (const file of job.artifacts || []) {
      const source = resolve(cwd, file)
      if (!existsSync(source)) continue
      const files = statSync(source).isDirectory()
        ? readdirSync(source, { recursive: true }).map((name) => join(file, name))
        : [file]
      for (const artifact of files) {
        const path = resolve(cwd, artifact)
        const stat = statSync(path)
        // Ignore stale reports/screenshots left by earlier attempts.
        if (!stat.isFile() || stat.mtimeMs < started - 1000) continue
        const target = join(caseDirectory, 'artifacts', artifact)
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(path, target)
      }
    }
  } catch (error) {
    result.evidenceError = error.message
  }
  if (result.status === 'passed' && !result.evidenceError) {
    try {
      // Exact mkdtemp result under this case; no user data or broad temp-directory deletion.
      rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch (error) {
      result.cleanupError = error.message
    }
  } else result.preservedTemporary = temporary
  writeFileSync(join(caseDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

async function runJobs(jobs, { directory = createRunDirectory(), ...options } = {}) {
  const results = []
  for (const job of jobs) {
    process.stdout.write(`[test] ${job.id}\n`)
    const failedDependency = job.requires?.find(
      (id) => results.find((r) => r.id === id)?.status !== 'passed'
    )
    let result
    try {
      result = failedDependency
        ? {
            id: job.id,
            status: 'blocked',
            reason: `Required job did not pass: ${failedDependency}`
          }
        : await runJob(job, { directory, ...options })
    } catch (error) {
      result = { id: job.id, status: 'runner-error', reason: error.stack || error.message }
    }
    results.push(result)
    writeFileSync(join(directory, 'summary.json'), JSON.stringify(results, null, 2) + '\n')
    process.stdout.write(`[${result.status}] ${job.id} (${result.durationMs || 0} ms)\n`)
  }
  return results
}

module.exports = { createRunDirectory, runJob, runJobs }
