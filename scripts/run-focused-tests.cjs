const { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } = require('node:fs')
const { createHash, randomUUID } = require('node:crypto')
const { delimiter, dirname, join, relative, resolve, sep, isAbsolute } = require('node:path')
const manifest = require('./test-manifest.cjs')
const { parseSelectionArgs, selectTests } = require('./test-selection.cjs')
const { assessVitestReport, assessStandaloneReport } = require('./test-result-adapters.cjs')

const storageMode = 'electron-ready-memory-sqlite-real-files'
const supportedStorage = new Set(manifest.storageTests)
const standaloneModes = new Map([
  ['tests/tag-commands-electron.mjs', 'electron-ready-disk-sqlite-tag-commands-mocked-ipc'],
  ['tests/native-async-prototype-electron.mjs', 'electron-worker-native-lifecycle-prototype'],
  ['tests/dispatcher-queue-lifetime-electron.mjs', 'windows-native-dispatcher-queue-lifetime'],
  ['tests/image-decode-electron.mjs', 'real-electron-owned-image-decode'],
  ['tests/settings-write-source-electron.mjs', 'electron-settings-source-frame-and-scope'],
  ['tests/test-failure-diagnostics-win.cjs', 'node-windows-failure-diagnostics'],
  ['tests/remote-daily-electron.mjs', 'electron-ready-remote-daily-http-sqlite'],
  ...[
    'tests/help-center-electron.mjs',
    'tests/note-list-completion-electron.mjs',
    'tests/note-text-color-electron.mjs',
    'tests/almanac-weather-electron.mjs',
    'tests/window-frame-electron.mjs',
    'tests/dock-trigger-electron.mjs',
    'tests/blur-z-order-electron.mjs',
    'tests/window-z-order-electron.mjs',
    'tests/window-border-electron.mjs',
    'tests/note-duration-electron.mjs',
    'tests/main-view-enhancements-electron.mjs',
    'tests/month-view-electron.mjs',
    'tests/week-view-electron.mjs',
    'tests/weather-settings-electron.mjs',
    'tests/titlebar-icon-scale-electron.mjs',
    'tests/view-visibility-shortcut-electron.mjs'
  ].map((file) => [file, 'electron-legacy-window-fixture']),
  ['tests/renderer-resource-lifetime-electron.mjs', 'electron-component-fixture'],
  ['tests/settings-panel-owners-electron.mjs', 'electron-component-fixture'],
  ['tests/session-draft-assets-prototype-electron.mjs', 'electron-session-draft-assets-prototype'],
  ['tests/session-draft-assets-electron.mjs', 'electron-session-draft-assets-production-ports'],
  ['tests/session-draft-assets-product-electron.mjs', 'electron-session-draft-assets-real-product'],
  ['tests/app-update-intent-electron.mjs', 'electron-real-app-update-display-intent'],
  ['tests/historical-note-move-db.mjs', 'electron-ready-disk-sqlite-historical-and-automatic-move'],
  ['tests/historical-note-move-electron.mjs', 'electron-ready-real-app-historical-move'],
  [
    'tests/date-context-controls-electron.mjs',
    'electron-real-app-date-context-controls-and-settings-reset'
  ],
  [
    'tests/note-draft-conflict-ui-electron.mjs',
    'real-app-note-editor-time-state-reminders-and-conflict'
  ],
  ['tests/template-quarterly-electron.mjs', 'real-app-quarterly-template-and-continuous-create'],
  ['tests/reminders-electron.mjs', 'real-app-reminder-popup-tray-and-editing'],
  [
    'tests/reminder-initialization-electron.mjs',
    'electron-ready-real-reminder-load-ready-lifecycle'
  ],
  [
    'tests/note-three-view-rules-ui-electron.mjs',
    'real-app-three-view-note-create-edit-and-calendar-defaults'
  ],
  [
    'tests/note-startup-recovery-electron.mjs',
    'real-app-startup-persisted-note-and-template-backlog-recovery'
  ],
  ['tests/quick-note-edit-electron.mjs', 'real-app-native-double-click-quick-edit-list-month-week'],
  ['tests/recurring-preview-electron.mjs', 'real-app-month-week-recurring-preview-and-read-only'],
  ['tests/note-state-db.mjs', 'electron-ready-disk-sqlite-note-state-time-reminder-transactions'],
  ['tests/recurrence-lifecycle-db.mjs', 'electron-ready-memory-sqlite-recurrence-lifecycle'],
  ['tests/capture-package-smoke.cjs', 'node-packaged-app-candidate'],
  ['tests/backend-integration.mjs', 'electron-ready-memory-and-disk-sqlite-backend-contracts'],
  ['tests/note-duration-db.mjs', 'electron-ready-disk-sqlite-duration-migration'],
  ['tests/note-list-completion-db.mjs', 'electron-ready-memory-sqlite-completion-ordering'],
  ['tests/note-remark-db.mjs', 'electron-ready-memory-sqlite-remark-migration'],
  ['tests/note-text-color-db.mjs', 'electron-ready-memory-sqlite-text-color-migration'],
  ['tests/recurring-preview-db.mjs', 'electron-ready-memory-sqlite-recurring-preview'],
  ['tests/reminder-database-integration.mjs', 'electron-ready-memory-sqlite-reminder-rounds'],
  [
    'tests/logging-actions-electron.mjs',
    'electron-real-app-diagnostic-actions-cross-window-export'
  ],
  ['tests/logging-motion-overhead-electron.mjs', 'electron-real-app-motion-diagnostic-overhead'],
  [
    'tests/daily-report-electron.mjs',
    'electron-real-app-daily-report-selected-range-txt-xlsx-export'
  ],
  ['tests/window-motion-diagnostics-native.mjs', 'windows-native-motion-collector-no-hwnd'],
  ['tests/window-z-order-diagnostics-native.mjs', 'windows-native-z-order-diagnostics-no-hwnd'],
  ['tests/window-z-order-diagnostics-electron.mjs', 'electron-native-zorder-failure-to-daily-log'],
  ['tests/settings-repository-db.mjs', 'electron-ready-disk-sqlite-reopen-settings'],
  ['tests/database-runtime-db.mjs', 'electron-ready-disk-sqlite-runtime-migration'],
  ['tests/database-migration-backup-electron.mjs', 'electron-ready-migration-backup-real-files'],
  [
    'tests/business-clear-admission-electron.mjs',
    'electron-ready-disk-sqlite-real-files-business-clear-admission-mocked-ipc'
  ],
  [
    'tests/attachment-recovery-reset-electron.mjs',
    'electron-disk-attachment-recovery-reset-three-process'
  ],
  ['tests/settings-runtime-electron.mjs', 'electron-main-app-settings-cross-view'],
  ['tests/settings-queue-electron.mjs', 'electron-ready-real-app-settings-queue-sections'],
  [
    'tests/settings-snapshot-ordering-electron.mjs',
    'electron-real-app-settings-snapshot-ordering-and-intents'
  ],
  ['tests/settings-snapshot-read-electron.mjs', 'electron-real-app-read-only-settings-snapshot'],
  ['tests/settings-page-leave-electron.mjs', 'electron-real-app-settings-page-leave-tray-sqlite'],
  [
    'tests/settings-application-ui-electron.mjs',
    'electron-real-app-settings-application-state-and-retry'
  ],
  ['tests/settings-quit-electron.mjs', 'electron-real-app-settings-tray-quit-sqlite'],
  [
    'tests/settings-exit-restart-electron.mjs',
    'electron-real-app-settings-exit-restart-two-process'
  ],
  [
    'tests/settings-operation-quit-electron.mjs',
    'electron-wallpaper-operation-direct-quit-save-rollback-and-reopen'
  ],
  ['tests/application-lifecycle-electron.mjs', 'electron-main-app-shutdown-three-process'],
  ['tests/app-ipc-electron.mjs', 'electron-real-preload-app-ipc-authorization'],
  ['tests/note-list-refresh-electron.mjs', 'electron-ready-real-app-list-refresh'],
  ['tests/renderer-recovery-electron.mjs', 'electron-ready-real-app-renderer-recovery'],
  [
    'tests/weather-notice-lifecycle-electron.mjs',
    'electron-real-app-weather-notice-request-lifecycle'
  ],
  ['tests/note-list-custom-electron.mjs', 'electron-ready-real-app-custom-list'],
  ['tests/note-list-tag-refresh-electron.mjs', 'electron-ready-real-app-tag-refresh'],
  ['tests/native-leaf-runtime-electron.mjs', 'electron-main-app-native-leaf-state'],
  ['tests/dock-runtime-electron.mjs', 'electron-real-app-dock-owner-native-state'],
  ['tests/background-navigation-electron.mjs', 'electron-ready-real-app-background-navigation'],
  ['tests/capture-delivery-electron.mjs', 'electron-ready-real-app-capture-delivery'],
  ['tests/capture-compositor-electron.mjs', 'electron-real-app-capture-compositor-pixels'],
  ['tests/capture-host-electron.mjs', 'electron-ready-capture-host-lifecycle'],
  ['tests/capture-lifecycle-electron.mjs', 'electron-ready-capture-overlay-lifecycle'],
  ['tests/calendar-workspace-electron.mjs', 'electron-ready-real-app-calendar-workspace'],
  ['tests/new-note-workflow-electron.mjs', 'real-app-new-note-session-and-layout'],
  ['tests/titlebar-native-drag-electron.mjs', 'electron-ready-real-app-titlebar-native-drag'],
  ['tests/presentation-mode-electron.mjs', 'electron-ready-real-app-presentation-mode'],
  ['tests/feature-runtime-electron.mjs', 'electron-ready-real-app-feature-clear-tray-activation'],
  ['tests/capture-business-electron.mjs', 'electron-real-app-capture-business-synthetic-transport'],
  [
    'tests/note-draft-conflict-electron.mjs',
    'electron-ready-file-sqlite-real-attachments-mocked-ipc'
  ],
  ['tests/sticky-persistence-electron.mjs', 'electron-ready-memory-sqlite-real-sticky-windows'],
  [
    'tests/sticky-quit-electron.mjs',
    'electron-real-app-sticky-initialization-tray-quit-and-reopen'
  ],
  [
    'tests/main-view-initialization-electron.mjs',
    'electron-real-app-main-view-ready-load-lifecycle'
  ],
  ['tests/main-view-startup-electron.mjs', 'electron-real-app-main-view-startup-ready-lifecycle'],
  [
    'tests/sticky-initialization-electron.mjs',
    'electron-ready-controlled-load-sqlite-real-sticky-initialization'
  ],
  ['tests/modal-queue-electron.mjs', 'electron-ready-real-app-modal-queue']
])

function executionBlock(entry) {
  if (entry.role === 'build')
    return entry.runtime === 'powershell' && process.platform !== 'win32'
      ? 'Native builds require the Windows MSVC toolchain'
      : null
  if (entry.runtime === 'vitest') return null
  if (entry.runtime === 'qt')
    return process.platform === 'win32' ? null : 'Qt Capture requires Windows'
  if (standaloneModes.has(entry.file))
    return process.platform === 'win32' ? null : 'This adapter requires Windows Electron'
  if (entry.level === 'storage' && entry.runtime === 'electron' && supportedStorage.has(entry.file))
    return process.platform === 'win32'
      ? null
      : 'This storage adapter currently requires Windows Electron'
  return 'This runtime has no verified target-result adapter; migrate its domain before execution'
}

function describe(entry) {
  return {
    id: entry.id,
    file: entry.file,
    role: entry.role,
    level: entry.level,
    runtime: entry.runtime,
    requires: entry.requires,
    runtimePrerequisites: entry.runtimePrerequisites,
    executionBlock: executionBlock(entry),
    contracts: entry.contracts,
    sourceDependencies: entry.sourceDependencies,
    sourceReadDependencies: entry.sourceReadDependencies,
    limits: entry.limits
  }
}

function createFocusedPlan(argv, { root = resolve(__dirname, '..'), entries } = {}) {
  const selection = parseSelectionArgs(argv)
  const directory = realpathSync(root)
  const registry = entries || manifest.createTestRegistry({ root: directory })
  const errors = manifest.validateTestRegistry(registry, { root: directory })
  if (errors.length) throw new Error('Invalid registry: ' + errors.join('\n'))
  const result = selectTests(registry, selection, { root: directory })
  return {
    mode: 'focused-plan',
    executed: false,
    root: directory,
    buildMode: result.buildMode,
    ...(result.selected.some((entry) => entry.file === 'tests/capture-compositor-electron.mjs')
      ? { releaseCaptureInputDriver: true }
      : {}),
    planOnly: result.planOnly,
    selected: result.selected.map(describe),
    dependencies: result.dependencies.map(describe),
    jobs: result.jobs.map(describe),
    order: result.jobs.map((entry) => entry.id),
    candidates: result.candidates.map(describe),
    reasons: result.reasons,
    runtimePrerequisites: result.runtimePrerequisites,
    warnings: [
      ...result.warnings,
      'Runtime prerequisites and build provenance are not certified by this plan.',
      'Selected Vitest, storage and Qt reports are verified; remaining legacy domains need adapters.',
      ...(result.buildMode === 'reuse-verified'
        ? ['Reuse requires matching input/output/toolchain provenance; unknown closure is refused.']
        : [])
    ]
  }
}

function normalizedEnvironment(env = process.env, nodeExecutable = process.execPath) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH'
  const parts = (env[pathKey] || '').split(delimiter).filter((part) => !/volta/i.test(part))
  const output = { ...env }
  for (const key of Object.keys(output)) if (key.toLowerCase() === 'path') delete output[key]
  output.PATH = dirname(nodeExecutable) + delimiter + parts.join(delimiter)
  return output
}

function assertInside(root, file) {
  const target = realpathSync(resolve(root, file))
  const part = relative(root, target)
  if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part))
    throw new Error('Execution target resolves outside the repository: ' + file)
  return target
}

function createFocusedJobs(
  plan,
  {
    nodeExecutable = process.execPath,
    env = normalizedEnvironment(process.env, nodeExecutable)
  } = {}
) {
  const qtNames = plan.selected
    .filter((entry) => entry.runtime === 'qt')
    .map((entry) => 'capture_' + /\/([^/]+)_test\.cpp$/.exec(entry.file)[1])
    .sort()
  const needed = new Set()
  function requireBuild(id) {
    if (needed.has(id)) return
    needed.add(id)
    for (const required of plan.jobs.find((entry) => entry.id === id)?.requires || [])
      requireBuild(required)
  }
  for (const entry of plan.selected)
    if (!executionBlock(entry)) for (const id of entry.requires) requireBuild(id)
  return plan.jobs.map((entry) => {
    const common = {
      id: entry.id,
      requires: entry.requires,
      metadata: {
        target: entry.file,
        level: entry.level,
        runtime: entry.runtime,
        contracts: entry.contracts,
        runtimePrerequisites: entry.runtimePrerequisites,
        sourceLimits: entry.limits
      },
      resultPolicy: 'required'
    }
    const blockedReason =
      executionBlock(entry) ||
      (entry.role === 'build' && !needed.has(entry.id)
        ? 'All consumers of this build lack a verified adapter; build was not started'
        : null)
    if (blockedReason) return { ...common, blockedReason }
    if (entry.role === 'build')
      return require('./test-build-jobs.cjs').createBuildJob(entry, plan, {
        nodeExecutable,
        qtNames: entry.id === 'build-capture' ? qtNames : [],
        env
      })
    if (entry.runtime === 'qt')
      return require('./test-build-jobs.cjs').createQtJob(entry, plan, {
        nodeExecutable,
        qtNames,
        env
      })
    assertInside(plan.root, entry.file)
    if (entry.runtime === 'vitest') {
      const vitest = join(plan.root, 'node_modules/vitest/vitest.mjs')
      if (!existsSync(vitest))
        return { ...common, blockedReason: 'Workspace Vitest runtime is missing' }
      return {
        ...common,
        command: nodeExecutable,
        timeoutMs: 180_000,
        prepare: ({ directory }) => ({
          args: [
            vitest,
            'run',
            entry.file,
            '--reporter=json',
            '--outputFile',
            join(directory, 'vitest.json')
          ]
        }),
        assessResult: (context) =>
          assessVitestReport(context, { file: entry.file, root: plan.root })
      }
    }
    const runToken = randomUUID()
    const executable = entry.runtime === 'node' ? nodeExecutable : require('electron')
    if (!existsSync(executable))
      return { ...common, blockedReason: 'Workspace Electron runtime is missing' }
    return {
      ...common,
      command: executable,
      args: [entry.file],
      gui: true,
      windowsHide: entry.runtime !== 'electron',
      // Leave cleanup time beyond the motion lifecycle and packaged app's bounded shutdown.
      // Settings restart keeps its existing child/suite budgets, including the
      // E12 navigation case; diagnostics and cleanup cannot turn a late exit green.
      timeoutMs: [
        'tests/main-view-initialization-electron.mjs',
        'tests/main-view-startup-electron.mjs'
      ].includes(entry.file)
        ? 300_000 // Each main-view controller keeps its original child and suite budgets, plus diagnostics.
        : entry.file === 'tests/sticky-initialization-electron.mjs'
          ? 90_000 // Controlled service fixture includes two original five-second deadlines.
          : entry.file === 'tests/settings-exit-restart-electron.mjs'
            ? 900_000
            : [
                  'tests/settings-operation-quit-electron.mjs',
                  'tests/sticky-quit-electron.mjs'
                ].includes(entry.file)
              ? 240_000 // Four children * 45s, plus first-failure diagnostics and cleanup.
              : [
                    'tests/logging-motion-overhead-electron.mjs',
                    'tests/capture-package-smoke.cjs'
                  ].includes(entry.file)
                ? 270_000
                : 180_000,
      prepare: ({ directory }) => {
        const packageEnv = {}
        if (entry.file === 'tests/capture-compositor-electron.mjs')
          packageEnv.ABANDON_CAPTURE_INPUT_DRIVER =
            require('./test-build-descriptors.cjs').describeBuild({
              root: plan.root,
              id: 'build-capture',
              nodeExecutable,
              qtNames,
              inputDriver: plan.releaseCaptureInputDriver === true,
              env
            }).inputDriverPath
        if (entry.file === 'tests/capture-package-smoke.cjs') {
          const supplied = env.ABANDON_TEST_PACKAGE_DIR
          if (!supplied || !isAbsolute(supplied))
            throw new Error(
              'Packaged acceptance requires an explicit absolute ABANDON_TEST_PACKAGE_DIR'
            )
          const candidate = realpathSync(supplied)
          const part = relative(plan.root, candidate)
          if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part))
            throw new Error('Packaged acceptance requires a workspace-owned candidate directory')
          for (const file of ['AbandonNote.exe', 'resources/app.asar'])
            if (!existsSync(join(candidate, file)))
              throw new Error('Candidate package is missing ' + file)
          packageEnv.ABANDON_TEST_PACKAGE_DIR = candidate
        }
        return {
          env: {
            ABANDON_TEST_RESULT_FILE: join(directory, 'standalone.json'),
            ABANDON_TEST_RUN_TOKEN: runToken,
            ABANDON_TEST_EVIDENCE_DIR: directory,
            ...packageEnv
          }
        }
      },
      assessResult: (context) =>
        assessStandaloneReport(context, {
          file: entry.file,
          suite: entry.file,
          runToken,
          mode: standaloneModes.get(entry.file) || storageMode
        })
    }
  })
}

function executionBaseline(plan, jobs, nodeExecutable) {
  const files = new Set([
    ...plan.jobs.map((entry) => entry.file),
    ...plan.jobs.flatMap((entry) => [
      ...(entry.sourceDependencies || []),
      ...(entry.sourceReadDependencies || [])
    ]),
    'scripts/test-manifest.cjs',
    'scripts/test-selection.cjs',
    'scripts/test-runner.cjs',
    'scripts/run-focused-tests.cjs',
    'scripts/test-result-adapters.cjs',
    'tests/helpers/test-result-recorder.cjs',
    'package-lock.json',
    'vitest.config.mjs'
  ])
  const hashes = {}
  for (const file of files)
    if (existsSync(resolve(plan.root, file))) {
      const target = assertInside(plan.root, file)
      hashes[file] = createHash('sha256').update(readFileSync(target)).digest('hex')
    }
  return {
    at: new Date().toISOString(),
    protocolVersion: 2,
    root: plan.root,
    nodeExecutable,
    nodeVersion: process.version,
    platform: process.platform,
    scope: 'explicit-focused',
    selection: plan,
    sourceHashes: hashes,
    jobs: jobs.map(({ id, command, args, requires, blockedReason, metadata }) => ({
      id,
      command,
      args,
      requires,
      blockedReason,
      metadata
    })),
    limits: [
      'This records selected files and infrastructure; not a complete import/build dependency closure',
      'No unrelated dirty files were selected automatically'
    ]
  }
}

async function executeFocusedPlan(
  plan,
  { evidenceRoot, nodeExecutable = process.execPath, env = process.env } = {}
) {
  if (plan.planOnly) throw new Error('Read-only plans cannot be executed')
  if (!plan.selected.length) throw new Error('No explicit target selected')
  const jobs = createFocusedJobs(plan, {
    nodeExecutable,
    env: normalizedEnvironment(env, nodeExecutable)
  })
  const baseline = executionBaseline(plan, jobs, nodeExecutable)
  const runner = require('./test-runner.cjs')
  const directory = runner.createRunDirectory(
    evidenceRoot || env.ABANDON_TEST_EVIDENCE_ROOT || join(plan.root, 'tmp/test-runs')
  )
  const directoryReal = realpathSync(directory)
  writeFileSync(join(directory, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n')
  process.stdout.write('Focused evidence: ' + directory + '\n')
  try {
    const results = await runner.runJobs(jobs, {
      directory,
      cwd: plan.root,
      env: normalizedEnvironment(env, nodeExecutable)
    })
    const summary = runner.summarizeResults(results)
    const report = join(directory, 'focused-summary.json')
    if (
      realpathSync(directory) !== directoryReal ||
      lstatSync(directory).isSymbolicLink() ||
      (existsSync(report) && (lstatSync(report).isSymbolicLink() || lstatSync(report).nlink > 1))
    )
      throw new Error('Focused summary destination changed or is linked; write refused')
    writeFileSync(report, JSON.stringify(summary, null, 2) + '\n')
    return {
      mode: 'focused-result',
      executed: true,
      directory,
      results,
      summary,
      exitCode: summary.successful ? 0 : 1
    }
  } catch (error) {
    error.executed = true
    error.directory = directory
    throw error
  }
}

async function main(argv = process.argv.slice(2), options = {}) {
  const plan = createFocusedPlan(argv, options)
  if (plan.planOnly) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n')
    return { ...plan, exitCode: 0 }
  }
  const result = await executeFocusedPlan(plan, options)
  process.stdout.write(
    JSON.stringify({ directory: result.directory, ...result.summary }, null, 2) + '\n'
  )
  process.exitCode = result.exitCode
  return result
}

if (require.main === module)
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        executed: Boolean(error.executed),
        ...(error.directory ? { directory: error.directory } : {}),
        error: {
          code: error.code || 'FOCUSED_ERROR',
          message: error.message
        }
      }) + '\n'
    )
    process.exitCode = 2
  })

module.exports = {
  createFocusedPlan,
  createFocusedJobs,
  executeFocusedPlan,
  normalizedEnvironment,
  main
}
