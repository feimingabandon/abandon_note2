const { readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const entry = require('./run-test-entry.cjs')
const manifest = require('./test-manifest.cjs')
const focused = require('./run-focused-tests.cjs')
const provenance = require('./test-build-provenance.cjs')
const { describeBuild } = require('./test-build-descriptors.cjs')

const releaseBuilds = Object.freeze(['build-native', 'build-capture', 'build-app'])
const releaseDiagnostics = 'tests/test-failure-diagnostics-win.cjs'

function createReleasePlan(argv, options = {}) {
  if (argv.some((argument) => argument !== '--plan'))
    throw new Error('Release window scope is fixed; only --plan is accepted')
  const root = options.root || resolve(__dirname, '..')
  const registry = options.entries || manifest.createTestRegistry({ root })
  for (const id of releaseBuilds)
    if (!registry.some((item) => item.id === id && item.role === 'build'))
      throw new Error('Release window scope is missing required build: ' + id)
  const entries = registry.map((item) =>
    item.id === 'build-app'
      ? { ...item, requires: [...new Set([...item.requires, 'build-native', 'build-capture'])] }
      : item
  )
  const capture = describeBuild({
    root,
    id: 'build-capture',
    inputDriver: true,
    env: focused.normalizedEnvironment(
      options.env || process.env,
      options.nodeExecutable || process.execPath
    )
  })
  const plan = (options.focused || focused).createFocusedPlan(
    [
      ...[...manifest.windowFrameTests, releaseDiagnostics].flatMap((file) => ['--file', file]),
      ...argv
    ],
    { ...options, root, entries }
  )
  return {
    ...plan,
    entry: { kind: 'window', scope: 'explicit-collection', collection: 'release-window-frame' },
    releaseBuilds: [...releaseBuilds],
    releaseCaptureInputDriver: true,
    packageAcceptanceEnvironment: { ABANDON_CAPTURE_INPUT_DRIVER: capture.inputDriverPath }
  }
}

function verifyReleaseBuildContinuity(plan, result, options = {}) {
  const environment = focused.normalizedEnvironment(
    options.env || process.env,
    options.nodeExecutable || process.execPath
  )
  const describe = options.describeBuild || describeBuild
  const checks = releaseBuilds.map((id) => {
    const build = result.results.find((item) => item.id === id)
    if (!build?.accepted || build.status !== 'passed')
      return { id, verified: false, reason: 'Required current-run build did not pass' }
    try {
      const before = JSON.parse(readFileSync(join(build.directory, 'build-after.json'), 'utf8'))
      const descriptor = describe({
        root: plan.root,
        id,
        nodeExecutable: options.nodeExecutable || process.execPath,
        inputDriver: id === 'build-capture' && plan.releaseCaptureInputDriver === true,
        env: environment
      })
      const current = provenance.createBuildSnapshot(descriptor.snapshotOptions)
      const verified =
        current.id === id &&
        current.root === plan.root &&
        !current.outputs.some((output) => output.kind === 'missing') &&
        current.outputs.some((output) => output.kind === 'file') &&
        JSON.stringify(before) === JSON.stringify(current)
      return {
        id,
        verified,
        fingerprint: current.fingerprint,
        reason: verified
          ? 'Current-run build inputs, known tools and all outputs remain unchanged after tests'
          : 'Build inputs, toolchain, mode or outputs changed after compilation',
        reusableClosure: current.closure.complete
      }
    } catch (error) {
      return { id, verified: false, reason: error.message }
    }
  })
  const report = {
    schema: 'abandon-release-build-continuity/v1',
    successful: checks.every((check) => check.verified),
    checks,
    limits: [
      'This checks continuity within this build-and-test invocation; it does not permit native cross-run reuse',
      'The installer must consume these outputs without another application/native build'
    ]
  }
  writeFileSync(
    join(result.directory, 'release-build-continuity.json'),
    JSON.stringify(report, null, 2) + '\n'
  )
  return report
}

async function releaseMain(argv, options = {}) {
  const plan = createReleasePlan(argv, options)
  process.stdout.write(JSON.stringify({ ...plan, executed: false }, null, 2) + '\n')
  if (plan.planOnly) return { ...plan, exitCode: 0 }
  const result = await (options.focused || focused).executeFocusedPlan(plan, options)
  if (result.summary.successful) {
    const continuity = verifyReleaseBuildContinuity(plan, result, options)
    if (!continuity.successful) {
      result.exitCode = 1
      result.releaseBuildContinuity = continuity
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        directory: result.directory,
        ...result.summary,
        ...(result.releaseBuildContinuity
          ? { successful: false, releaseBuildContinuity: result.releaseBuildContinuity }
          : {})
      },
      null,
      2
    ) + '\n'
  )
  process.exitCode = result.exitCode
  return result
}

function main(argv, options) {
  return argv[0] === 'release-window-frame'
    ? releaseMain(argv.slice(1), options)
    : entry.main('window', argv, options)
}

if (require.main === module) main(process.argv.slice(2)).catch(entry.reportError)

module.exports = {
  groups: entry.windowGroups,
  main,
  createReleasePlan,
  verifyReleaseBuildContinuity
}
