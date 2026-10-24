const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} = require('node:fs')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')
const { createFailureDiagnostics } = require('./test-failure-diagnostics.cjs')

// Run and case attempts are immutable names, including retries and sanitized-ID collisions.
function createRunDirectory(
  root = resolve(process.env.ABANDON_TEST_EVIDENCE_ROOT || 'tmp/test-runs')
) {
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, new Date().toISOString().replaceAll(/[:.]/g, '-') + '-'))
}

function isWithin(root, file) {
  const path = relative(root, file)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
}

function safeArtifactPath(root, value) {
  if (
    typeof value !== 'string' ||
    !value ||
    isAbsolute(value) ||
    /^[A-Za-z]:|^[\\/]{2}/.test(value) ||
    value.includes(':') ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error(`Artifact must be a repository-relative path: ${String(value)}`)
  const source = resolve(root, value)
  if (!isWithin(root, source) || source === root)
    throw new Error(`Artifact escapes its root: ${value}`)
  let current = root
  for (const part of relative(root, source).split(sep)) {
    current = join(current, part)
    if (!existsSync(current)) return source
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
      throw new Error(`Linked artifact is not readable evidence: ${value}`)
    if (!isWithin(realpathSync(root), realpathSync(current)))
      throw new Error(`Artifact resolves outside its root: ${value}`)
  }
  return source
}

function listOwnedFiles(root, current = root) {
  const files = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const file = join(current, entry.name)
    const stat = lstatSync(file)
    if (entry.isSymbolicLink() || stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
      throw new Error(`Linked evidence is not readable: ${relative(root, file)}`)
    if (!isWithin(realpathSync(root), realpathSync(file)))
      throw new Error(`Evidence resolves outside its root: ${relative(root, file)}`)
    if (entry.isDirectory()) files.push(...listOwnedFiles(root, file))
    else if (entry.isFile()) files.push(file)
  }
  return files
}

function assertOwnedDirectory(directory, originalReal, enclosingReal) {
  if (
    lstatSync(directory).isSymbolicLink() ||
    realpathSync(directory) !== originalReal ||
    (enclosingReal && !isWithin(enclosingReal, originalReal))
  )
    throw new Error('Owned evidence directory changed or is linked; access refused')
}

function ownedDestination(root, originalReal, file) {
  assertOwnedDirectory(root, originalReal)
  if (!isWithin(root, file) || root === file)
    throw new Error('Evidence destination escapes its owned directory')
  let current = root
  for (const part of relative(root, file).split(sep)) {
    current = join(current, part)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
      throw new Error('Linked evidence destination; write refused')
    if (!isWithin(originalReal, realpathSync(current)))
      throw new Error('Evidence destination resolves outside its owned directory')
  }
  return file
}

function bounded(callback, timeoutMs, label) {
  let timer
  return Promise.race([
    Promise.resolve().then(callback),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

function hasCompletedAssertions(assertions) {
  if (typeof assertions === 'number') return Number.isInteger(assertions) && assertions > 0
  if (!assertions || typeof assertions !== 'object') return false
  const { total, passed, failed, skipped } = assertions
  return (
    [total, passed, failed, skipped].every((count) => Number.isInteger(count) && count >= 0) &&
    total === passed + failed + skipped &&
    passed > 0 &&
    failed === 0
  )
}

function isResultSuccessful(result) {
  return (
    result?.accepted === true &&
    result.processResult?.status === 'passed' &&
    result.businessResult?.status === 'passed' &&
    result.evidenceResult?.status === 'complete' &&
    result.cleanupResult?.status === 'complete' &&
    result.reportResult?.phase === 'final' &&
    result.reportResult?.status === 'complete' &&
    (!result.runReportResult || result.runReportResult.status === 'complete')
  )
}

const caseReportWriters = new WeakMap()

function rejectEvidence(result, message) {
  result.accepted = false
  result.evidenceResult ||= { copied: [], missing: [], stale: [], errors: [] }
  result.evidenceResult.errors ||= []
  result.evidenceResult.errors.push(message)
  result.evidenceResult.status = 'collection-failed'
  result.evidenceError = result.evidenceResult.errors.join('; ')
  process.stderr.write(`[evidence-error] ${message}\n`)
  if (result.processResult?.status === 'passed')
    result.status = result.businessResult?.status === 'failed' ? 'failed' : 'unverified'
}

function summarizeResults(results) {
  const summary = {
    total: results.length,
    verifiedPassed: 0,
    legacyUnproven: 0,
    unverified: 0,
    failed: 0,
    blocked: 0,
    successful: false,
    statusCounts: Object.create(null)
  }
  for (const result of results) {
    summary.statusCounts[result.status] = (summary.statusCounts[result.status] || 0) + 1
    if (isResultSuccessful(result)) summary.verifiedPassed++
    else if (result.status === 'blocked') summary.blocked++
    else if (result.businessResult?.status === 'failed') summary.failed++
    else if (
      result.processResult?.status === 'passed' &&
      result.businessResult?.mode === 'legacy-process-exit'
    )
      summary.legacyUnproven++
    else if (['passed', 'unverified'].includes(result.processResult?.status)) summary.unverified++
    else summary.failed++
  }
  summary.successful = summary.total > 0 && summary.verifiedPassed === summary.total
  return summary
}

async function runJob(
  job,
  {
    directory,
    cwd = process.cwd(),
    env = process.env,
    cleanupTemporary,
    writeLog = writeSync,
    collectFailureDiagnostics
  } = {}
) {
  const runRootReal = realpathSync(directory)
  const caseDirectory = mkdtempSync(
    join(directory, (job.id.replaceAll(/[^\w.-]/g, '_') || 'case') + '-')
  )
  const caseDirectoryReal = realpathSync(caseDirectory)
  const temporary = mkdtempSync(join(caseDirectory, 'temp-'))
  const temporaryReal = realpathSync(temporary)
  const profile = join(temporary, 'profile')
  mkdirSync(profile)
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const context = { directory: caseDirectory, temporary, profile, cwd, startedMs }
  // GUI adapters opt out explicitly: Windows launch hiding can suppress show().
  // `gui` also covers Node diagnostic fixtures, whose consoles must stay hidden.
  const windowsHide = job.windowsHide !== false
  let args = Array.isArray(job.args) ? job.args : []
  let childEnv = { ...env }
  let preparationError
  if (!job.blockedReason && job.prepare) {
    try {
      const prepared = await bounded(
        () => job.prepare(context),
        job.preparationTimeoutMs || 5000,
        'Job preparation'
      )
      if (Array.isArray(prepared)) args = prepared
      else if (prepared && typeof prepared === 'object') {
        if (prepared.args !== undefined) {
          if (!Array.isArray(prepared.args)) throw new Error('Prepared args must be an array')
          args = prepared.args
        }
        if (prepared.env) childEnv = { ...childEnv, ...prepared.env }
      }
    } catch (error) {
      preparationError = error.message
    }
  }
  // Only this job owns these paths, even when a trusted prepare hook supplies other environment.
  childEnv = { ...childEnv, TEMP: temporary, TMP: temporary, TMPDIR: temporary }
  delete childEnv.ELECTRON_RUN_AS_NODE
  delete childEnv.ABANDON_TEST_USER_DATA
  if (job.electronNode) childEnv.ELECTRON_RUN_AS_NODE = '1'
  if (job.gui) childEnv.ABANDON_TEST_USER_DATA = profile

  const logErrors = []
  let unsafeDirectory = false
  const descriptors = {}
  for (const name of ['stdout', 'stderr']) {
    try {
      descriptors[name] = openSync(
        ownedDestination(caseDirectory, caseDirectoryReal, join(caseDirectory, `${name}.log`)),
        'wx'
      )
    } catch (error) {
      logErrors.push(`${name}: ${error.message}`)
      unsafeDirectory = true
    }
  }
  let timedOut = false
  let launchError = null
  let terminationIncomplete = false
  let firstFailure = null
  let failureDiagnostics
  const recordFirstFailure = (kind, details) => {
    firstFailure ||= { kind, at: new Date().toISOString(), ...details }
  }
  let completion = { code: null, signal: null }
  if (!job.blockedReason && !preparationError && !logErrors.length) {
    let child
    let killFallback
    let timeout
    completion = await new Promise((done) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearTimeout(killFallback)
        done(value)
      }
      let stopping = false
      const stopOwnedChild = async (reason) => {
        if (!child || settled) return
        if (stopping) return
        stopping = true
        // The business deadline has already failed. Diagnostic time must not
        // turn an earlier log failure into a later timeout or erase its cause.
        clearTimeout(timeout)
        await failureDiagnostics?.capture(reason)
        if (settled) return
        // `exit` can precede `close` while descendants retain the output pipes.
        // Do not send a PID-based tree kill after the root exited during capture.
        const rootRunning = () => child.exitCode === null && child.signalCode === null
        if (!rootRunning()) terminationIncomplete = true
        else if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
          })
          killer.unref()
          killer.on('error', () => {
            if (rootRunning()) child.kill()
          })
          killer.on('exit', (code) => {
            if (code !== 0 && !settled && rootRunning()) child.kill()
          })
        } else child.kill('SIGKILL')
        if (!killFallback)
          killFallback = setTimeout(() => {
            terminationIncomplete = true
            child.stdout?.destroy()
            child.stderr?.destroy()
            child.unref()
            finish({ code: null, signal: null })
          }, 5000)
      }
      try {
        const spawnedMs = Date.now()
        child = spawn(job.command, args, {
          cwd,
          env: childEnv,
          windowsHide,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        failureDiagnostics = createFailureDiagnostics(
          {
            gui: job.gui,
            directory: caseDirectory,
            command: job.command,
            args,
            spawnedMs,
            pid: child.pid,
            cwd,
            writeEvidence(name, entry) {
              writeFileSync(
                ownedDestination(caseDirectory, caseDirectoryReal, join(caseDirectory, name)),
                JSON.stringify(entry, null, 2) + '\n',
                { flag: 'wx' }
              )
            }
          },
          collectFailureDiagnostics ? { collect: collectFailureDiagnostics } : undefined
        )
        for (const name of ['stdout', 'stderr']) {
          child[name].on('data', (chunk) => {
            if (settled || logErrors.length) return
            try {
              let offset = 0
              while (offset < chunk.length) {
                const written = writeLog(descriptors[name], chunk, offset, chunk.length - offset)
                if (!written) throw new Error('Log write made no progress')
                offset += written
              }
            } catch (error) {
              logErrors.push(`${name}: ${error.message}`)
              recordFirstFailure('output-write', { stream: name, error: error.message })
              void stopOwnedChild('output-write')
            }
          })
          child[name].on('error', (error) => {
            logErrors.push(`${name}: ${error.message}`)
            recordFirstFailure('output-stream', { stream: name, error: error.message })
            void stopOwnedChild('output-stream')
          })
        }
        child.on('error', (error) => {
          launchError ||= error.message
          recordFirstFailure('launch-error', { error: error.message })
        })
        child.on('exit', (code, signal) => {
          if (code !== 0 || signal) recordFirstFailure('process-exit', { code, signal })
          failureDiagnostics.exited(code, signal)
        })
        child.on('close', (code, signal) => finish({ code, signal }))
        timeout = setTimeout(() => {
          timedOut = true
          recordFirstFailure('timeout', { timeoutMs: job.timeoutMs || 180_000 })
          void stopOwnedChild('timeout')
        }, job.timeoutMs || 180_000)
      } catch (error) {
        launchError ||= error.message
        recordFirstFailure('launch-error', { error: error.message })
        finish({ code: null, signal: null })
      }
    })
  }
  const diagnosticResult = await failureDiagnostics?.finish()
  for (const [name, descriptor] of Object.entries(descriptors)) {
    try {
      closeSync(descriptor)
    } catch (error) {
      logErrors.push(`${name}: ${error.message}`)
    }
  }
  const processStatus = job.blockedReason
    ? 'not-run'
    : preparationError ||
        (logErrors.length && completion.code === null && !launchError && !timedOut)
      ? 'runner-error'
      : timedOut
        ? 'timeout'
        : launchError
          ? 'launch-error'
          : completion.code === 0
            ? 'passed'
            : 'failed'
  const processResult = {
    status: processStatus,
    ...completion,
    launchError,
    timedOut,
    terminationIncomplete
  }
  const result = {
    protocolVersion: 2,
    id: job.id,
    ...(job.metadata ? { metadata: job.metadata } : {}),
    command: job.command,
    args,
    windowsHide,
    startedAt,
    durationMs: Date.now() - startedMs,
    ...completion,
    launchError,
    timedOut,
    status: job.blockedReason ? 'blocked' : processStatus,
    ...(job.blockedReason ? { reason: job.blockedReason } : {}),
    ...(preparationError ? { reason: preparationError } : {}),
    directory: caseDirectory,
    processResult,
    ...(firstFailure ? { firstFailure } : {}),
    ...(diagnosticResult ? { failureDiagnostics: diagnosticResult } : {}),
    businessResult: {
      status: 'unproven',
      mode: 'legacy-process-exit',
      reason: 'No result adapter'
    },
    evidenceResult: {
      status: 'complete',
      copied: [],
      missing: [],
      stale: [],
      errors: logErrors,
      unsafeDirectory
    },
    cleanupResult: {
      status: 'pending',
      runnerStatus: 'pending',
      reason: 'Awaiting result and evidence'
    },
    accepted: false
  }
  let stdout = ''
  let stderr = ''
  for (const name of ['stdout', 'stderr']) {
    try {
      const logPath = ownedDestination(
        caseDirectory,
        caseDirectoryReal,
        join(caseDirectory, `${name}.log`)
      )
      const contents = readFileSync(logPath, 'utf8')
      if (name === 'stdout') stdout = contents
      else stderr = contents
    } catch (error) {
      result.evidenceResult.errors.push(`${name}: ${error.message}`)
      result.evidenceResult.unsafeDirectory = true
    }
  }
  if (job.blockedReason || preparationError || launchError)
    result.businessResult = {
      status: 'not-run',
      mode: 'process',
      reason: result.reason || launchError
    }
  else if (job.assessResult) {
    try {
      const business = await bounded(
        () => job.assessResult({ ...context, stdout, stderr, completion, processResult }),
        job.assessmentTimeoutMs || 5000,
        'Result assessment'
      )
      if (
        !business ||
        !['passed', 'failed', 'unproven', 'skipped', 'not-run'].includes(business.status)
      )
        throw new Error('Result adapter returned an invalid business status')
      result.businessResult = business
      if (
        business.status === 'passed' &&
        !['build', 'check'].includes(job.resultKind) &&
        !hasCompletedAssertions(business.assertions)
      )
        result.businessResult = {
          ...business,
          status: 'unproven',
          reason: 'No completed assertions were proven (zero or all skipped)'
        }
    } catch (error) {
      result.businessResult = { status: 'unproven', mode: 'adapter-error', reason: error.message }
    }
  } else if (['build', 'check'].includes(job.resultKind))
    result.businessResult = {
      status: processStatus === 'passed' ? 'passed' : 'failed',
      mode: 'process-check',
      reason: `Explicit ${job.resultKind} task; no business assertion count claimed`
    }
  else if (job.resultPolicy === 'required')
    result.businessResult = {
      status: 'unproven',
      mode: 'missing-adapter',
      reason: 'Required result adapter is absent'
    }

  const scriptCleanup = result.businessResult.scriptCleanup
  const scriptEvidence = result.businessResult.scriptEvidence
  if (scriptEvidence) result.evidenceResult.scriptEvidence = scriptEvidence

  // Copy diagnostics and declared reports before any cache removal. Never traverse linked assets.
  try {
    assertOwnedDirectory(caseDirectory, caseDirectoryReal, runRootReal)
    assertOwnedDirectory(temporary, temporaryReal, caseDirectoryReal)
    for (const file of listOwnedFiles(temporary)) {
      if (!file.endsWith('.jsonl')) continue
      const target = ownedDestination(
        caseDirectory,
        caseDirectoryReal,
        join(caseDirectory, 'diagnostics', relative(temporary, file))
      )
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(file, target)
      result.evidenceResult.copied.push(relative(caseDirectory, target))
    }
  } catch (error) {
    result.evidenceResult.errors.push(error.message)
    result.evidenceResult.unsafeDirectory = true
  }
  const required = new Set(job.requiredArtifacts || [])
  for (const artifact of new Set([...(job.artifacts || []), ...required])) {
    try {
      const source = safeArtifactPath(resolve(cwd), artifact)
      if (!existsSync(source)) {
        if (required.has(artifact)) result.evidenceResult.missing.push(artifact)
        continue
      }
      const files = statSync(source).isDirectory() ? listOwnedFiles(source) : [source]
      let freshFiles = 0
      for (const file of files) {
        if (!statSync(file).isFile() || statSync(file).mtimeMs < startedMs) continue
        const target = ownedDestination(
          caseDirectory,
          caseDirectoryReal,
          join(caseDirectory, 'artifacts', relative(resolve(cwd), file))
        )
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(file, target)
        result.evidenceResult.copied.push(relative(caseDirectory, target))
        freshFiles++
      }
      if (required.has(artifact) && !freshFiles) result.evidenceResult.stale.push(artifact)
    } catch (error) {
      result.evidenceResult.errors.push(error.message)
    }
  }
  const updateEvidenceStatus = () => {
    const evidence = result.evidenceResult
    evidence.status = evidence.errors.length
      ? 'collection-failed'
      : evidence.missing.length || evidence.stale.length
        ? 'missing'
        : scriptEvidence && scriptEvidence.status !== 'complete'
          ? scriptEvidence.status === 'failed'
            ? 'collection-failed'
            : 'incomplete'
          : 'complete'
    if (evidence.errors.length) result.evidenceError = evidence.errors.join('; ')
  }
  updateEvidenceStatus()
  let recoveryDirectory
  let recoveryDirectoryReal
  const primaryReport = join(caseDirectory, 'result.json')
  let reportGeneration = 0
  const persist = (phase) => {
    const report = {
      phase,
      generation: ++reportGeneration,
      status: 'complete',
      primaryPath: primaryReport,
      primaryUsable: true,
      authoritativePath: primaryReport
    }
    result.reportResult = report
    try {
      const target = ownedDestination(caseDirectory, caseDirectoryReal, primaryReport)
      writeFileSync(target, JSON.stringify(result, null, 2) + '\n')
      return true
    } catch (error) {
      // Reject before serializing recovery; a former successful attempt is no longer authoritative.
      rejectEvidence(result, `result.json: ${error.message}`)
      result.evidenceResult.unsafeDirectory = true
      updateEvidenceStatus()
      report.status = 'unavailable'
      report.primaryUsable = false
      report.authoritativePath = null
      // If a child replaced a case path, report only in a new owned sibling, never through that link.
      try {
        assertOwnedDirectory(directory, runRootReal)
        if (!recoveryDirectory) {
          recoveryDirectory = mkdtempSync(join(directory, 'runner-report-'))
          recoveryDirectoryReal = realpathSync(recoveryDirectory)
        }
        result.recoveryReport = join(recoveryDirectory, 'result.json')
        report.status = 'recovered'
        report.authoritativePath = result.recoveryReport
        writeFileSync(
          ownedDestination(recoveryDirectory, recoveryDirectoryReal, result.recoveryReport),
          JSON.stringify(result, null, 2) + '\n'
        )
      } catch (recoveryError) {
        rejectEvidence(result, `recovery report: ${recoveryError.message}`)
        report.status = 'unavailable'
        report.authoritativePath = null
        updateEvidenceStatus()
      }
      return false
    }
  }
  // Record the attempt before cleanup: a report failure must not erase the recovery scene.
  persist('provisional')
  const proven = processStatus === 'passed' && result.businessResult.status === 'passed'
  if (
    proven &&
    result.evidenceResult.status === 'complete' &&
    (!scriptCleanup || scriptCleanup.status === 'complete')
  ) {
    try {
      assertOwnedDirectory(caseDirectory, caseDirectoryReal, runRootReal)
      assertOwnedDirectory(temporary, temporaryReal, caseDirectoryReal)
      if (cleanupTemporary)
        await bounded(() => cleanupTemporary(temporary, context), 5000, 'Cleanup')
      else rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      if (existsSync(temporary)) throw new Error('Owned temporary directory remains after cleanup')
      result.cleanupResult = {
        status: 'complete',
        runnerStatus: 'complete',
        mode: 'owned-directory',
        ...(scriptCleanup ? { scriptCleanup } : {})
      }
    } catch (error) {
      result.cleanupError = error.message
      result.cleanupResult = {
        status: 'failed',
        runnerStatus: 'failed',
        reason: error.message,
        ...(scriptCleanup ? { scriptCleanup } : {})
      }
    }
  } else
    result.cleanupResult = {
      status: scriptCleanup?.status === 'failed' ? 'failed' : 'pending',
      runnerStatus: 'pending',
      reason:
        'Attempt retained for unproven, failed, blocked, incomplete evidence or script cleanup',
      ...(scriptCleanup ? { scriptCleanup } : {})
    }
  if (existsSync(temporary)) result.preservedTemporary = temporary
  result.accepted =
    proven &&
    result.evidenceResult.status === 'complete' &&
    result.cleanupResult.status === 'complete'
  if (!result.accepted && processStatus === 'passed' && job.resultPolicy === 'required')
    result.status = result.businessResult.status === 'failed' ? 'failed' : 'unverified'
  result.durationMs = Date.now() - startedMs
  persist('final')
  caseReportWriters.set(result, () => persist('final'))
  return result
}

function persistRunReports(results, result, { directory, runRootReal, runToken, total }) {
  const generation = results.length
  const primarySummaryPath = join(directory, 'summary.json')
  const primaryCompletionPath = join(directory, 'completion.json')
  const primaryStatusPath = join(directory, 'run-report-status.json')
  const status = {
    schema: 'abandon-test-run-report/v1',
    runToken,
    generation,
    total,
    finalRun: generation === total,
    phase: 'final',
    status: 'complete',
    primaryStatus: 'complete',
    primarySummaryPath,
    primaryCompletionPath,
    summaryPath: primarySummaryPath,
    completionPath: primaryCompletionPath,
    statusPath: primaryStatusPath
  }
  const writeOwned = (root, originalReal, file, value) =>
    writeFileSync(ownedDestination(root, originalReal, file), JSON.stringify(value, null, 2) + '\n')
  const completion = () => ({
    ...summarizeResults(results),
    reportGeneration: { runToken, generation, total }
  })
  try {
    // Only a final marker for the same generation makes this pair readable. Interim generations
    // cannot certify an entire run if publication of a later attempt fails.
    writeOwned(directory, runRootReal, primaryStatusPath, {
      ...status,
      phase: 'provisional',
      status: 'publishing',
      finalRun: false,
      primaryStatus: 'unavailable',
      summaryPath: null,
      completionPath: null
    })
    result.runReportResult = status
    writeOwned(directory, runRootReal, primarySummaryPath, results)
    writeOwned(directory, runRootReal, primaryCompletionPath, completion())
    writeOwned(directory, runRootReal, primaryStatusPath, status)
    return
  } catch (error) {
    result.summaryError = error.message
    rejectEvidence(result, `Run report: ${error.message}`)
    status.status = 'unavailable'
    status.primaryStatus = 'failed'
    status.summaryPath = null
    status.completionPath = null
    result.runReportResult = status
  }

  let recoveryDirectory
  let recoveryDirectoryReal
  try {
    assertOwnedDirectory(directory, runRootReal)
    recoveryDirectory = mkdtempSync(join(directory, 'run-report-'))
    recoveryDirectoryReal = realpathSync(recoveryDirectory)
    status.status = 'recovered'
    status.summaryPath = join(recoveryDirectory, 'summary.json')
    status.completionPath = join(recoveryDirectory, 'completion.json')
    status.statusPath = join(recoveryDirectory, 'run-report-status.json')
    try {
      // This redirects readers without claiming the recovery files have already been written.
      writeOwned(directory, runRootReal, primaryStatusPath, {
        ...status,
        status: 'recovery-required',
        summaryPath: null,
        completionPath: null,
        recoveryStatusPath: status.statusPath
      })
    } catch (error) {
      rejectEvidence(result, `Run status redirect: ${error.message}`)
    }
    // Use the original captured ownership checks; never trust a newly resolved child path.
    caseReportWriters.get(result)?.()
    writeOwned(recoveryDirectory, recoveryDirectoryReal, status.summaryPath, results)
    writeOwned(recoveryDirectory, recoveryDirectoryReal, status.completionPath, completion())
    writeOwned(recoveryDirectory, recoveryDirectoryReal, status.statusPath, status)
  } catch (error) {
    rejectEvidence(result, `Run recovery report: ${error.message}`)
    status.status = 'unavailable'
    status.summaryPath = null
    status.completionPath = null
    caseReportWriters.get(result)?.()
    try {
      const statusRoot = recoveryDirectory || directory
      const statusRootReal = recoveryDirectoryReal || runRootReal
      writeOwned(statusRoot, statusRootReal, status.statusPath, status)
    } catch (statusError) {
      rejectEvidence(result, `Run unavailable status: ${statusError.message}`)
      status.statusPath = null
      caseReportWriters.get(result)?.()
    }
  }
}

async function runJobs(jobs, { directory = createRunDirectory(), ...options } = {}) {
  const runRootReal = realpathSync(directory)
  const runToken = randomUUID()
  const results = []
  for (const job of jobs) {
    process.stdout.write(`[test] ${job.id}\n`)
    const failedDependency = job.requires?.find(
      (id) => !isResultSuccessful(results.find((result) => result.id === id))
    )
    let result
    try {
      result = await runJob(
        {
          ...job,
          ...(failedDependency && !job.blockedReason
            ? { blockedReason: `Required job was not verified successful: ${failedDependency}` }
            : {})
        },
        { directory, ...options }
      )
    } catch (error) {
      result = {
        id: job.id,
        status: 'runner-error',
        reason: error.stack || error.message,
        businessResult: { status: 'not-run', mode: 'runner-error' },
        evidenceResult: { status: 'collection-failed', errors: [error.message] },
        cleanupResult: { status: 'pending', reason: 'Runner failed before completion' },
        accepted: false
      }
    }
    results.push(result)
    persistRunReports(results, result, { directory, runRootReal, runToken, total: jobs.length })
    const displayStatus =
      result.status === 'passed' && !isResultSuccessful(result)
        ? 'unverified; process passed; accepted=false'
        : result.status
    process.stdout.write(`[${displayStatus}] ${job.id} (${result.durationMs || 0} ms)\n`)
    if (
      !isResultSuccessful(result) &&
      result.directory &&
      !result.evidenceResult?.unsafeDirectory
    ) {
      for (const stream of ['stderr', 'stdout']) {
        const logPath = join(result.directory, `${stream}.log`)
        if (!existsSync(logPath)) continue
        try {
          const output = readFileSync(logPath, 'utf8')
          if (output) process.stdout.write(`[${job.id} ${stream} tail]\n${output.slice(-16000)}\n`)
        } catch (error) {
          process.stderr.write(`[evidence-read-error] ${error.message}\n`)
        }
      }
    }
  }
  return results
}

module.exports = { createRunDirectory, runJob, runJobs, isResultSuccessful, summarizeResults }
