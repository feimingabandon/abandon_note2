const { execFileSync } = require('node:child_process')
const { realpathSync } = require('node:fs')
const { resolve } = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const manifest = require('./test-manifest.cjs')
const { domainRules } = require('./test-domain-rules.cjs')

// Each rule names reviewed consumers. Registry imports/source reads are displayed
// as candidates, never promoted to execution because a filename looks relevant.
const infrastructureRules = Object.freeze({
  'scripts/test-manifest.cjs': ['tests/test-manifest.test.js', 'tests/test-selection.test.js'],
  'scripts/test-selection.cjs': [
    'tests/test-selection.test.js',
    'tests/run-focused-tests.test.js',
    'tests/test-entrypoints.test.js'
  ],
  'scripts/test-runner.cjs': ['tests/test-runner.test.js', 'tests/run-focused-tests.test.js'],
  'scripts/test-result-adapters.cjs': [
    'tests/test-result-adapters.test.js',
    'tests/run-focused-tests.test.js'
  ],
  'tests/helpers/test-result-recorder.cjs': [
    'tests/test-result-recorder.test.js',
    ...manifest.storageTests
  ],
  'scripts/run-focused-tests.cjs': [
    'tests/run-focused-tests.test.js',
    'tests/test-entrypoints.test.js',
    'tests/ci-test-selection.test.js'
  ],
  'scripts/run-test-entry.cjs': [
    'tests/test-entrypoints.test.js',
    'tests/ci-test-selection.test.js'
  ],
  'scripts/run-ci-tests.cjs': ['tests/ci-test-selection.test.js'],
  'scripts/test-domain-rules.cjs': ['tests/ci-test-selection.test.js'],
  'scripts/test-main-domain-rules.cjs': ['tests/ci-test-selection.test.js'],
  'scripts/test-renderer-domain-rules.cjs': ['tests/ci-test-selection.test.js'],
  'scripts/test-build-provenance.cjs': [
    'tests/test-build-provenance.test.js',
    'tests/run-focused-tests.test.js'
  ],
  'scripts/test-build-descriptors.cjs': [
    'tests/test-build-descriptors.test.js',
    'tests/test-build-provenance.test.js',
    'tests/capture-build-selection.test.js'
  ],
  'scripts/test-build-jobs.cjs': [
    'tests/run-focused-tests.test.js',
    'tests/test-build-provenance.test.js'
  ],
  'scripts/run-capture-test.cjs': ['tests/capture-build-selection.test.js'],
  'scripts/run-electron-node-tests.cjs': ['tests/test-entrypoints.test.js'],
  'scripts/run-electron-window-tests.cjs': ['tests/test-entrypoints.test.js'],
  'scripts/run-full-tests.cjs': ['tests/test-runner.test.js'],
  'scripts/run-electron-wallpaper-tests.cjs': ['tests/run-focused-tests.test.js'],
  'scripts/run-electron-attachment-tests.cjs': ['tests/run-focused-tests.test.js'],
  '.github/workflows/ci.yml': ['tests/ci-test-selection.test.js'],
  '.github/workflows/release.yml': [
    'tests/ci-test-selection.test.js',
    'tests/test-entrypoints.test.js'
  ],
  'vitest.config.mjs': [
    'tests/test-manifest.test.js',
    'tests/test-selection.test.js',
    'tests/test-entrypoints.test.js'
  ],
  'package.json': [
    'tests/test-entrypoints.test.js',
    'tests/ci-test-selection.test.js',
    'tests/package-native-config.test.js'
  ],
  'electron-builder.base.yml': ['tests/package-native-config.test.js'],
  'electron-builder.win.yml': ['tests/package-native-config.test.js'],
  'electron-builder.yml': [
    'tests/package-native-config.test.js',
    'tests/security-hardening.test.js'
  ],
  'scripts/package-native-plan.cjs': ['tests/package-native-config.test.js'],
  'scripts/configure-packaged-native.cjs': ['tests/package-native-config.test.js'],
  'scripts/validate-packaged-app.cjs': ['tests/package-native-config.test.js'],
  'scripts/generate-app-icons.py': ['tests/security-hardening.test.js']
})
// 只登记已审查的平台资产删除，重新引入同名资源必须重新审查，不能取得成功的 Mac 任务。
const removedDesktopAssetRules = Object.freeze({
  'electron-builder.mac.yml': [
    'tests/package-native-config.test.js',
    'tests/security-hardening.test.js'
  ],
  'build/entitlements.mac.plist': ['tests/security-hardening.test.js'],
  'build/icon.icns': ['tests/security-hardening.test.js']
})
const storageRules = Object.freeze({
  'src/main/db/db-images.js': ['tests/attachment-storage-electron.mjs'],
  'src/main/db/db-wallpapers.js': ['tests/wallpaper-storage-electron.mjs']
})
// The old JS edge predicate was removed in favor of the native monitor. Preserve
// its protection through the monitor contracts and actual native edge exercises.
const replacementProtectionRules = Object.freeze({
  'tests/dock-edge.test.js': [
    'tests/native-edge-monitor.test.js',
    'tests/native-edge-monitor-source.test.js',
    'tests/dock-trigger-electron.mjs'
  ]
})
// This opt-in probe registers a temporary Windows toast identity and requires a
// cached executable resource editor. Its constructor-only migration is checked by
// automated notification contracts; CI does not claim to execute the manual probe.
const reviewedOptInChanges = Object.freeze({
  'tests/logging-motion-overhead-electron.mjs': [
    'tests/window-motion-diagnostics.test.js',
    'tests/diagnostic-controller.test.js',
    'tests/window-motion-diagnostics-native.mjs'
  ],
  'tests/capture-package-smoke.cjs': [
    'tests/package-native-config.test.js',
    'tests/capture-business-electron.mjs'
  ],
  'tests/reminder-native-acceptance.cjs': [
    'tests/reminder-notification.test.js',
    'tests/reminders-electron.mjs'
  ]
})
const verifiedDomainTargets = new Set([
  ...manifest.storageTests,
  ...manifest.databaseTests,
  ...Object.values(domainRules).flat(),
  ...Object.values(replacementProtectionRules).flat(),
  ...Object.values(reviewedOptInChanges).flat()
])

function normalizedChange(change) {
  const input = typeof change === 'string' ? { file: change, status: 'M' } : change
  if (
    !input ||
    typeof input.file !== 'string' ||
    !input.file ||
    !['A', 'M', 'D', 'T'].includes(input.status)
  )
    throw new Error('Every committed change needs a file and supported Git status')
  const file = input.file.replace(/\\/g, '/')
  if (
    file.startsWith('/') ||
    file.includes(':') ||
    file.split('/').some((part) => !part || part === '.' || part === '..') ||
    Array.from(file).some((char) => char.charCodeAt(0) < 32)
  )
    throw new Error('Changed paths must be bounded repository-relative files')
  return { file, status: input.status }
}

function documentationFile(file) {
  return (
    file === 'README.md' ||
    file === 'LICENSE' ||
    file === 'AGENTS.md' ||
    file === 'PRIVACY.md' ||
    file === 'native_capture/README.md' ||
    (file.startsWith('docs/') && /\.(?:md|png|jpe?g|gif|webp|svg)$/.test(file))
  )
}

function requireSupportedCiPlatform(platform) {
  if (platform !== 'win32')
    throw new Error(`Unsupported CI desktop platform: ${platform}; Windows is required`)
}

function selectCiTests({
  changedFiles,
  registry,
  platform = process.platform,
  packageScriptOnly = false,
  lockfileVersionOnly = false
} = {}) {
  requireSupportedCiPlatform(platform)
  if (!Array.isArray(changedFiles) || !Array.isArray(registry))
    throw new Error('CI selection requires explicit committed changes and a registry')
  const changes = changedFiles.map(normalizedChange)
  const byFile = new Map(registry.map((entry) => [entry.file, entry]))
  const selected = new Map()
  const reasons = Object.create(null)
  const unmapped = []
  const needsDomainValidation = []
  const candidates = []
  const noTestFiles = []
  const addTargets = (files, change, rule) => {
    for (const file of files) {
      const entry = byFile.get(file)
      if (!entry || entry.role !== 'test') {
        unmapped.push({
          file: change.file,
          reason: 'Reviewed rule references an unavailable test: ' + file
        })
        continue
      }
      selected.set(entry.id, entry)
      if (!reasons[entry.id]) reasons[entry.id] = []
      reasons[entry.id].push({ changedFile: change.file, status: change.status, rule })
    }
  }
  for (const change of changes) {
    const entry = byFile.get(change.file)
    const associated = registry.filter(
      (test) =>
        test.role === 'test' &&
        [...test.sourceDependencies, ...test.sourceReadDependencies].includes(change.file)
    )
    if (associated.length)
      candidates.push({
        changedFile: change.file,
        ids: associated.map((test) => test.id),
        basis: 'registered-import-or-source-read-candidate-only'
      })
    if (change.status === 'D' && Object.hasOwn(replacementProtectionRules, change.file)) {
      addTargets(replacementProtectionRules[change.file], change, 'reviewed-replacement-protection')
    } else if (change.status !== 'D' && Object.hasOwn(reviewedOptInChanges, change.file)) {
      addTargets(
        reviewedOptInChanges[change.file],
        change,
        'reviewed-opt-in-probe-automated-consumers'
      )
      noTestFiles.push({
        file: change.file,
        reason:
          change.file === 'tests/logging-motion-overhead-electron.mjs'
            ? 'The physical timing benchmark remains explicit; automated collector and diagnostics contracts are selected separately'
            : change.file === 'tests/capture-package-smoke.cjs'
              ? 'Requires an explicit built candidate; the Windows release package-acceptance job executes this probe after packaging'
              : 'The opt-in Windows toast probe itself remains manual; automated notification contracts are selected separately'
      })
    } else if (entry?.role === 'test') {
      if (change.status === 'D')
        needsDomainValidation.push({
          file: change.file,
          reason: 'Deleted tests require an explicit replacement-protection review'
        })
      else if (entry.level === 'unit' && entry.runtime === 'vitest')
        addTargets([entry.file], change, 'changed-registered-unit-target')
      else if (verifiedDomainTargets.has(entry.file))
        addTargets([entry.file], change, 'changed-verified-domain-target')
      else
        needsDomainValidation.push({
          file: change.file,
          target: entry.id,
          reason: 'This domain is not yet admitted to ordinary CI with a verified result adapter'
        })
    } else if (change.status === 'D' && change.file.startsWith('tests/'))
      needsDomainValidation.push({
        file: change.file,
        reason: 'Deleted test/support assets require an explicit replacement-protection review'
      })
    else if (Object.hasOwn(removedDesktopAssetRules, change.file)) {
      if (change.status === 'D')
        addTargets(
          removedDesktopAssetRules[change.file],
          change,
          'reviewed-unsupported-desktop-asset-removal'
        )
      else
        needsDomainValidation.push({
          file: change.file,
          reason: 'Unsupported desktop assets cannot be reintroduced without a platform review'
        })
    } else if (change.file === 'package-lock.json' && lockfileVersionOnly) {
      addTargets(infrastructureRules['package.json'], change, 'reviewed-lockfile-version-only')
    } else if (change.file === 'package.json' && !packageScriptOnly)
      needsDomainValidation.push({
        file: change.file,
        reason:
          'Package metadata/dependencies changed or could not be classified; script-entry tests alone cannot cover this scope'
      })
    else if (Object.hasOwn(infrastructureRules, change.file))
      addTargets(infrastructureRules[change.file], change, 'reviewed-infrastructure-consumers')
    else if (Object.hasOwn(storageRules, change.file))
      addTargets(storageRules[change.file], change, 'reviewed-real-files-storage-contract')
    else if (Object.hasOwn(domainRules, change.file))
      addTargets(domainRules[change.file], change, 'reviewed-domain-contracts')
    else if (documentationFile(change.file))
      noTestFiles.push({
        file: change.file,
        reason:
          'Repository documentation or documentation media; no executable product source changed'
      })
    else if (/^(?:src\/|native_blur\/|native_capture\/)/.test(change.file))
      needsDomainValidation.push({
        file: change.file,
        reason:
          'The runtime/shared/native domain has no reviewed CI scope mapping yet; candidates are advisory'
      })
    else
      unmapped.push({
        file: change.file,
        reason: 'No reviewed CI selection rule; automatic full-suite fallback is forbidden'
      })
  }
  const state =
    unmapped.length || needsDomainValidation.length
      ? 'needs-domain-validation'
      : selected.size
        ? 'selected'
        : changes.length
          ? 'no-tests'
          : 'no-change'
  return {
    mode: 'committed-change-ci-plan',
    executed: false,
    state,
    changes,
    selected: [...selected.values()].map((entry) => ({
      id: entry.id,
      file: entry.file,
      level: entry.level,
      runtime: entry.runtime,
      requires: [...(entry.requires || [])],
      runtimePrerequisites: [...(entry.runtimePrerequisites || [])]
    })),
    reasons,
    candidates,
    unmapped,
    needsDomainValidation,
    noTestFiles,
    noTestsReason: selected.size
      ? null
      : changes.length === 0
        ? 'The verified committed range contains no file changes'
        : noTestFiles.length === changes.length
          ? 'Only repository documentation or documentation media changed'
          : null,
    exitCode: state === 'needs-domain-validation' ? 3 : 0,
    limits: [
      'Only reviewed mapping rules select targets; registry dependencies are candidate evidence',
      'This plan does not certify desktop, customer-machine, packaging, or release readiness'
    ]
  }
}

function validatedSha(value, label) {
  if (
    typeof value !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value) ||
    /^0+$/.test(value)
  )
    throw new Error(label + ' must be a nonzero full commit SHA; no baseline fallback is allowed')
  return value
}

function collectCommittedChanges({
  baseSha,
  headSha,
  baseMode = 'exact',
  root = resolve(__dirname, '..'),
  git = execFileSync
} = {}) {
  baseSha = validatedSha(baseSha, 'CI base')
  headSha = validatedSha(headSha, 'CI head')
  if (!['exact', 'merge-base'].includes(baseMode))
    throw new Error('CI base mode must be exact or merge-base')
  const runGit = (args) =>
    git('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  const repository = runGit(['rev-parse', '--show-toplevel']).trim()
  if (realpathSync(repository) !== realpathSync(root))
    throw new Error('CI root must be the exact repository checkout')
  runGit(['cat-file', '-e', baseSha + '^{commit}'])
  runGit(['cat-file', '-e', headSha + '^{commit}'])
  const effectiveBaseSha =
    baseMode === 'merge-base'
      ? validatedSha(runGit(['merge-base', baseSha, headSha]).trim(), 'CI merge base')
      : baseSha
  const fields = runGit([
    'diff',
    '--name-status',
    '-z',
    '--no-renames',
    effectiveBaseSha,
    headSha,
    '--'
  ]).split('\0')
  if (fields.pop() !== '') throw new Error('Git change list did not have a complete NUL terminator')
  if (fields.length % 2) throw new Error('Git change list was incomplete')
  const changes = []
  for (let index = 0; index < fields.length; index += 2)
    changes.push(normalizedChange({ status: fields[index], file: fields[index + 1] }))
  return { baseSha, headSha, baseMode, effectiveBaseSha, changedFiles: changes }
}

function parseCiArgs(argv, env = process.env) {
  const options = {
    baseSha: env.CI_TEST_BASE_SHA,
    headSha: env.CI_TEST_HEAD_SHA,
    baseMode: env.CI_TEST_BASE_MODE || 'exact',
    planOnly: false
  }
  const flags = { '--base': 'baseSha', '--head': 'headSha', '--base-mode': 'baseMode' }
  const seen = new Set()
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--plan') {
      options.planOnly = true
      continue
    }
    if (
      !Object.hasOwn(flags, flag) ||
      seen.has(flag) ||
      !argv[index + 1] ||
      argv[index + 1].startsWith('--')
    )
      throw new Error('Unknown, duplicate, or incomplete CI argument: ' + flag)
    seen.add(flag)
    options[flags[flag]] = argv[++index]
  }
  return options
}

function validReleaseVersion(value) {
  if (typeof value !== 'string') return false
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value
    )
  return Boolean(
    match && (!match[4] || match[4].split('.').every((identifier) => !/^0\d+$/.test(identifier)))
  )
}

function classifyPackageChange(
  range,
  { root = resolve(__dirname, '..'), git = execFileSync } = {}
) {
  if (!range.changedFiles.some((change) => change.file === 'package.json')) return null
  try {
    const readAt = (sha) =>
      JSON.parse(
        git('git', ['show', validatedSha(sha, 'Package version commit') + ':package.json'], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 2 * 1024 * 1024
        })
      )
    const base = readAt(range.effectiveBaseSha)
    const head = readAt(range.headSha)
    if (
      !base ||
      !head ||
      typeof base !== 'object' ||
      typeof head !== 'object' ||
      Array.isArray(base) ||
      Array.isArray(head)
    )
      throw new Error('Package must be an object')
    delete base.scripts
    delete head.scripts
    if (isDeepStrictEqual(base, head)) {
      return {
        scriptOnly: true,
        reason: 'Committed package changes are confined to script entries or formatting'
      }
    }
    if (validReleaseVersion(base.version) && validReleaseVersion(head.version)) {
      delete base.version
      delete head.version
      if (isDeepStrictEqual(base, head)) {
        return {
          scriptOnly: false,
          versionAndScriptsOnly: true,
          reason:
            'Only the valid release version and script entries changed; dependencies are identical'
        }
      }
    }
    return {
      scriptOnly: false,
      reason: 'Committed package changes include metadata or dependencies'
    }
  } catch (error) {
    return { scriptOnly: false, reason: 'Package change classification failed: ' + error.message }
  }
}

function classifyLockfileChange(
  range,
  { root = resolve(__dirname, '..'), git = execFileSync } = {}
) {
  if (
    !range.changedFiles.some((change) =>
      ['package.json', 'package-lock.json'].includes(change.file)
    )
  )
    return null
  try {
    const readAt = (sha, file) =>
      JSON.parse(
        git('git', ['show', validatedSha(sha, 'Lockfile version commit') + ':' + file], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024
        })
      )
    const base = readAt(range.effectiveBaseSha, 'package-lock.json')
    const head = readAt(range.headSha, 'package-lock.json')
    const pkg = readAt(range.headSha, 'package.json')
    if (
      !validReleaseVersion(pkg.version) ||
      head.version !== pkg.version ||
      head.packages?.['']?.version !== pkg.version
    ) {
      return { versionOnly: false, reason: 'Lockfile and package release versions do not match' }
    }
    delete base.version
    delete head.version
    if (base.packages?.['']) delete base.packages[''].version
    if (head.packages?.['']) delete head.packages[''].version
    return {
      versionOnly: isDeepStrictEqual(base, head),
      reason: 'Dependency tree must remain identical apart from matching release versions'
    }
  } catch (error) {
    return { versionOnly: false, reason: 'Lockfile change classification failed: ' + error.message }
  }
}

async function main(argv = process.argv.slice(2), options = {}) {
  const platform = options.platform ?? process.platform
  requireSupportedCiPlatform(platform)
  const config = parseCiArgs(argv, options.env || process.env)
  const root = options.root || resolve(__dirname, '..')
  const range = collectCommittedChanges({
    ...config,
    root,
    ...(options.git ? { git: options.git } : {})
  })
  const registry = options.registry || manifest.createTestRegistry({ root })
  const errors = manifest.validateTestRegistry(registry, { root })
  if (errors.length) throw new Error('Invalid CI registry: ' + errors.join('\n'))
  const packageChange = classifyPackageChange(range, {
    root,
    ...(options.git ? { git: options.git } : {})
  })
  const lockfileChange = classifyLockfileChange(range, {
    root,
    ...(options.git ? { git: options.git } : {})
  })
  const plan = {
    ...selectCiTests({
      changedFiles: range.changedFiles,
      registry,
      platform,
      packageScriptOnly:
        (packageChange?.scriptOnly === true || packageChange?.versionAndScriptsOnly === true) &&
        lockfileChange?.versionOnly === true,
      lockfileVersionOnly: lockfileChange?.versionOnly === true
    }),
    range,
    packageChange,
    lockfileChange
  }
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n')
  if (plan.exitCode || !plan.selected.length || config.planOnly) {
    process.exitCode = plan.exitCode
    return plan
  }
  const focused = options.focused || require('./run-focused-tests.cjs')
  return focused.main(
    plan.selected.flatMap((entry) => ['--id', entry.id]),
    { ...options, root, entries: registry }
  )
}

if (require.main === module)
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        executed: Boolean(error.executed),
        state: 'invalid-ci-range-or-scope',
        error: error.message
      }) + '\n'
    )
    process.exitCode = 2
  })

module.exports = {
  infrastructureRules,
  removedDesktopAssetRules,
  storageRules,
  replacementProtectionRules,
  reviewedOptInChanges,
  domainRules,
  selectCiTests,
  collectCommittedChanges,
  classifyPackageChange,
  classifyLockfileChange,
  parseCiArgs,
  main
}
