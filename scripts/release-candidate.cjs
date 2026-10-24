const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const schema = 'abandon-release-candidate/v1'
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const positive = (value) => /^[1-9]\d*$/.test(String(value))

function identity(env = process.env) {
  assert(sha(env.GITHUB_SHA), 'An exact commit SHA is required')
  assert(
    positive(env.GITHUB_RUN_ID) && positive(env.GITHUB_RUN_ATTEMPT),
    'Run identity is required'
  )
  return {
    commit: env.GITHUB_SHA,
    runId: String(env.GITHUB_RUN_ID),
    attempt: Number(env.GITHUB_RUN_ATTEMPT)
  }
}

function filesFor(version) {
  assert(/^\d+\.\d+\.\d+$/.test(version), 'A stable package version is required')
  const installer = `Abandon-Note-${version}-windows-x64-setup.exe`
  return [installer, installer + '.blockmap', 'latest.yml']
}

function ownedFile(root, name) {
  assert(
    typeof name === 'string' && name && !name.includes(':') && !name.includes('\\'),
    'Invalid evidence path'
  )
  const target = path.resolve(root, name)
  const relative = path.relative(root, target)
  assert(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'Evidence escapes its directory'
  )
  let current = path.resolve(root)
  assert(!fs.lstatSync(current).isSymbolicLink(), 'Linked evidence directory refused')
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current)
    assert(!stat.isSymbolicLink() && !(stat.isFile() && stat.nlink > 1), 'Linked evidence refused')
  }
  assert(fs.statSync(target).isFile(), 'Evidence must be a file')
  return target
}

function collect(root, { expected, jobStatus, scope, source }) {
  const failures = []
  const seen = new Set()
  const runs = []
  let continuityVerified = false
  if (jobStatus !== 'success') failures.push({ reason: `Workflow job status: ${jobStatus}` })
  if (!fs.existsSync(root)) failures.push({ reason: 'No test evidence directory was produced' })
  else
    for (const entry of fs
      .readdirSync(root, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Unexpected or linked test attempt')
        const directory = path.join(root, entry.name)
        const status = json(ownedFile(directory, 'run-report-status.json'))
        const results = json(ownedFile(directory, 'summary.json'))
        const completion = json(ownedFile(directory, 'completion.json'))
        assert(
          status.phase === 'final' && status.status === 'complete' && status.finalRun === true,
          'Test attempt report is incomplete'
        )
        assert(Array.isArray(results) && results.length > 0, 'Test attempt has no results')
        assert(
          status.generation === results.length && status.total === results.length,
          'Test attempt generation differs from its results'
        )
        assert(
          completion.reportGeneration?.runToken === status.runToken &&
            completion.reportGeneration?.generation === results.length &&
            completion.reportGeneration?.total === results.length,
          'Test completion does not match its report'
        )
        const { isResultSuccessful } = require('./test-runner.cjs')
        for (const result of results) {
          if (!isResultSuccessful(result))
            failures.push({
              run: entry.name,
              id: result.id,
              status: result.status,
              process: result.processResult,
              business: result.businessResult,
              reason:
                result.reason ||
                result.preparationError ||
                result.evidenceError ||
                'Attempt was not verified successful',
              evidence: `${entry.name}/${path.basename(result.directory || 'unknown')}`
            })
          else seen.add(result.id)
        }
        assert(
          completion.successful === true && completion.verifiedPassed === results.length,
          'Attempt completion was not successful'
        )
        if (scope === 'windows' && results.some((result) => result.id === 'build-capture')) {
          const continuity = json(ownedFile(directory, 'release-build-continuity.json'))
          const builds = ['build-native', 'build-capture', 'build-app']
          assert(
            continuity.schema === 'abandon-release-build-continuity/v1' &&
              continuity.successful === true &&
              continuity.checks?.length === 3,
            'Release build continuity was not verified'
          )
          assert(
            new Set(continuity.checks.map((check) => check.id)).size === 3 &&
              builds.every((id) =>
                continuity.checks.some(
                  (check) =>
                    check.id === id &&
                    check.verified === true &&
                    /^[a-f0-9]{64}$/.test(check.fingerprint)
                )
              ),
            'Release build inputs or outputs drifted'
          )
          continuityVerified = true
        }
        runs.push({
          directory: entry.name,
          total: results.length,
          summarySha256: digest(path.join(directory, 'summary.json'))
        })
      } catch (error) {
        failures.push({ run: entry.name, reason: error.message })
      }
    }
  for (const id of expected)
    if (!seen.has(id))
      failures.push({ id, reason: 'Required test or build was not verified successful' })
  if (scope === 'windows' && !continuityVerified)
    failures.push({ reason: 'Missing successful current-run release build continuity' })
  assert(expected.length > 0, 'Release scope must be explicit and non-empty')
  return {
    schema,
    kind: 'job-evidence',
    scope,
    ...source,
    successful: failures.length === 0,
    required: expected,
    verified: [...seen].sort(),
    runs,
    failures
  }
}

function verifyReport(report, scope, source) {
  assert(
    report.schema === schema && report.kind === 'job-evidence' && report.scope === scope,
    'Unexpected release evidence schema or scope'
  )
  assert(
    report.commit === source.commit &&
      report.runId === source.runId &&
      report.attempt === source.attempt,
    'Release evidence belongs to another commit or attempt'
  )
  assert(
    report.successful === true && Array.isArray(report.failures) && report.failures.length === 0,
    'Release evidence contains unresolved failed attempts'
  )
  assert(
    Array.isArray(report.required) &&
      report.required.length > 0 &&
      new Set(report.required).size === report.required.length,
    'Missing or duplicate required release targets'
  )
  assert(
    Array.isArray(report.verified) && report.required.every((id) => report.verified.includes(id)),
    'Required release scope was not verified'
  )
  assert(Array.isArray(report.runs) && report.runs.length > 0, 'Missing release attempt reports')
}

function assemble({ directory, quality, windows, version, source }) {
  verifyReport(quality, 'quality', source)
  verifyReport(windows, 'windows', source)
  const files = filesFor(version).map((name) => {
    const file = ownedFile(directory, name)
    return { name, size: fs.statSync(file).size, sha256: digest(file) }
  })
  assert(
    files.every((file) => file.size > 0),
    'Empty release artifact'
  )
  return {
    schema,
    kind: 'verified-candidate',
    version,
    platform: 'win32',
    arch: 'x64',
    ...source,
    quality,
    windows,
    files
  }
}

function verify(candidate, { directory, version, commit, runId }) {
  assert(
    candidate.schema === schema && candidate.kind === 'verified-candidate',
    'Invalid candidate manifest'
  )
  assert(
    candidate.version === version && candidate.platform === 'win32' && candidate.arch === 'x64',
    'Candidate version or platform differs'
  )
  assert(
    candidate.commit === commit &&
      candidate.runId === String(runId) &&
      sha(commit) &&
      positive(runId),
    'Candidate commit or run differs'
  )
  assert(Number.isInteger(candidate.attempt) && candidate.attempt > 0, 'Invalid candidate attempt')
  verifyReport(candidate.quality, 'quality', candidate)
  verifyReport(candidate.windows, 'windows', candidate)
  const expected = filesFor(version)
  assert(
    Array.isArray(candidate.files) &&
      candidate.files.length === expected.length &&
      new Set(candidate.files.map((file) => file.name)).size === expected.length,
    'Candidate artifact list differs'
  )
  assert(
    fs.readdirSync(directory).sort().join('\n') === [...expected].sort().join('\n'),
    'Unexpected or missing downloaded release artifacts'
  )
  for (const name of expected) {
    const recorded = candidate.files.find((file) => file.name === name)
    const file = ownedFile(directory, name)
    assert(
      recorded &&
        recorded.size > 0 &&
        recorded.size === fs.statSync(file).size &&
        recorded.sha256 === digest(file),
      `Candidate artifact changed: ${name}`
    )
  }
  return true
}

async function selectCandidate({ github, owner, repo, commit }) {
  assert(sha(commit), 'An exact candidate commit is required')
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner,
    repo,
    workflow_id: 'release.yml',
    event: 'workflow_dispatch',
    head_sha: commit,
    per_page: 100
  })
  const latest = runs
    .filter(
      (run) =>
        run.head_sha === commit &&
        run.event === 'workflow_dispatch' &&
        run.head_repository?.full_name === `${owner}/${repo}`
    )
    .sort((a, b) => b.id - a.id)[0]
  if (!latest) return ''
  // Never fall back to an older green candidate past a newer failure or active run.
  assert(
    latest.status === 'completed' && latest.conclusion === 'success',
    'Latest candidate is not successful. Investigate its first failure before creating a new candidate.'
  )
  assert(
    latest.run_attempt === 1,
    'A retried run cannot silently replace its failed attempt. Investigate and create a fresh candidate run.'
  )
  return String(latest.id)
}

async function requireSuccessfulCi({ github, owner, repo, commit }) {
  assert(sha(commit), 'An exact CI commit is required')
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner,
    repo,
    workflow_id: 'ci.yml',
    head_sha: commit,
    per_page: 100
  })
  const latest = runs
    .filter(
      (run) => run.head_sha === commit && run.head_repository?.full_name === `${owner}/${repo}`
    )
    .sort((a, b) => b.id - a.id)[0]
  assert(
    latest?.status === 'completed' && latest.conclusion === 'success',
    'The latest ordinary CI for this exact commit must succeed before release; investigate its failure instead of falling back to older results'
  )
  return String(latest.id)
}

function markdown(report) {
  const lines = [
    `### ${report.scope} release evidence`,
    '',
    `Commit: ${report.commit}`,
    `Run: ${report.runId}, attempt ${report.attempt}`,
    '',
    `Verified: ${report.verified.length}; required: ${report.required.length}; accepted: ${report.successful}`,
    ''
  ]
  if (report.failures.length) {
    lines.push(
      'Failed attempts remain failures. A later green run is not a root-cause explanation.',
      ''
    )
    for (const failure of report.failures)
      lines.push(`- ${JSON.stringify(failure).replaceAll('<', '&lt;')}`)
  }
  return lines.join('\n') + '\n'
}

function main(argv = process.argv.slice(2), env = process.env) {
  const source = identity(env)
  const version = json('package.json').version
  if (argv[0] === 'collect') {
    const scope = argv[1]
    assert(['quality', 'windows', 'ci'].includes(scope), 'Unknown evidence scope')
    let report
    try {
      const entry = require('./run-test-entry.cjs')
      const plan =
        scope === 'quality'
          ? entry.createEntryPlan('release-quality', ['--plan'])
          : scope === 'windows'
            ? require('./run-electron-window-tests.cjs').createReleasePlan(['--plan'])
            : json('tmp/ci-plan.json')
      const expected = (plan.jobs || plan.selected).map((job) => job.id)
      if (scope === 'windows') expected.push('tests/capture-package-smoke.cjs')
      report =
        scope === 'ci' &&
        ['no-tests', 'no-change'].includes(plan.state) &&
        plan.exitCode === 0 &&
        !expected.length &&
        env.RELEASE_JOB_STATUS === 'success'
          ? {
              schema,
              kind: 'job-evidence',
              scope,
              ...source,
              successful: true,
              required: [],
              verified: [],
              runs: [],
              failures: [],
              noTestsReason: plan.noTestsReason
            }
          : collect(path.resolve('tmp/test-runs'), {
              expected,
              jobStatus: env.RELEASE_JOB_STATUS,
              scope,
              source
            })
    } catch (error) {
      // npm/toolchain/planning failures can precede the runner. Still emit an explicit
      // failed report; missing evidence must never look like an empty successful run.
      report = {
        schema,
        kind: 'job-evidence',
        scope,
        ...source,
        successful: false,
        required: [],
        verified: [],
        runs: [],
        failures: [{ reason: error.message, jobStatus: env.RELEASE_JOB_STATUS }]
      }
    }
    fs.mkdirSync('tmp/release-evidence', { recursive: true })
    fs.writeFileSync(`tmp/release-evidence/${scope}.json`, JSON.stringify(report, null, 2) + '\n')
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown(report))
    assert(
      report.successful,
      'Release evidence contains failed, blocked, missing or incomplete attempts; inspect the retained evidence'
    )
  } else if (argv[0] === 'assemble') {
    const candidate = assemble({
      directory: 'release-assets',
      quality: json('candidate-evidence/quality.json'),
      windows: json('candidate-evidence/windows.json'),
      version,
      source
    })
    fs.mkdirSync('candidate-evidence', { recursive: true })
    fs.writeFileSync('candidate-evidence/candidate.json', JSON.stringify(candidate, null, 2) + '\n')
  } else if (argv[0] === 'verify') {
    verify(json('candidate-evidence/candidate.json'), {
      directory: 'release-assets',
      version,
      commit: source.commit,
      runId: env.RELEASE_SOURCE_RUN_ID
    })
  } else throw new Error('Expected collect, assemble or verify')
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(error.message + '\n')
    process.exitCode = 1
  }
}
module.exports = {
  schema,
  identity,
  filesFor,
  collect,
  assemble,
  verify,
  selectCandidate,
  requireSuccessfulCi,
  markdown,
  main
}
