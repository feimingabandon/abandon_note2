import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ci from '../scripts/run-ci-tests.cjs'
import manifest from '../scripts/test-manifest.cjs'
import focused from '../scripts/run-focused-tests.cjs'

const roots = []
const repository = resolve(import.meta.dirname, '..')
const fixtureRegistry = () =>
  [
    ...new Set([
      ...Object.values(ci.infrastructureRules).flat(),
      ...Object.values(ci.domainRules).flat(),
      ...manifest.storageTests,
      'tests/arbitrary.test.js'
    ])
  ].map((file) => ({
    id: file,
    file,
    role: 'test',
    level: file.endsWith('.mjs') ? 'storage' : 'unit',
    runtime: file.endsWith('.mjs') ? 'electron' : 'vitest',
    sourceDependencies: [],
    sourceReadDependencies: []
  }))
const plan = (changedFiles, platform = 'win32', registry = fixtureRegistry()) =>
  ci.selectCiTests({ changedFiles, platform, registry })
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('reviewed committed-change CI selection', () => {
  it.each(['darwin', 'linux', 'freebsd'])(
    'refuses %s before planning an empty, documentation or executable scope',
    async (platform) => {
      for (const files of [[], ['README.md'], ['src/main/db/db-wallpapers.js']])
        expect(() => plan(files, platform)).toThrow(`Unsupported CI desktop platform: ${platform}`)
      const git = vi.fn()
      await expect(ci.main([], { platform, git, registry: [] })).rejects.toThrow(
        `Unsupported CI desktop platform: ${platform}`
      )
      expect(git).not.toHaveBeenCalled()
    }
  )

  it('distinguishes a verified empty range from documentation-only changes', () => {
    expect(plan([])).toMatchObject({ state: 'no-change', selected: [], exitCode: 0 })
    expect(plan(['docs/testing/README.md', 'README.md'])).toMatchObject({
      state: 'no-tests',
      selected: [],
      exitCode: 0
    })
    expect(plan([]).noTestsReason).not.toBe(plan(['README.md']).noTestsReason)
  })

  it('selects the changed registered unit file without adding guessed neighbors', () => {
    expect(plan(['tests/arbitrary.test.js']).selected.map((entry) => entry.file)).toEqual([
      'tests/arbitrary.test.js'
    ])
    expect(plan(['tests/unregistered.test.js'])).toMatchObject({
      state: 'needs-domain-validation',
      selected: [],
      exitCode: 3
    })
  })

  it('uses the reviewed consumer rule and gives a reason for every target', () => {
    const selected = plan(['scripts/test-selection.cjs'])
    expect(selected.selected.map((entry) => entry.file)).toEqual(
      ci.infrastructureRules['scripts/test-selection.cjs']
    )
    expect(
      selected.selected.every(
        (entry) => selected.reasons[entry.id][0].rule === 'reviewed-infrastructure-consumers'
      )
    ).toBe(true)
  })

  it('selects a reviewed leaf domain without expanding a broad entry change', () => {
    const result = plan(['src/main/windows/window-geometry-persistence.js'])
    expect(result.selected.map((entry) => entry.file)).toEqual(
      ci.domainRules['src/main/windows/window-geometry-persistence.js']
    )
    expect(
      result.selected.every(
        (entry) => result.reasons[entry.id][0].rule === 'reviewed-domain-contracts'
      )
    ).toBe(true)
    expect(plan(['src/main/unreviewed-entry.js']).state).toBe('needs-domain-validation')
  })

  it('uses real registered executable consumers for every admitted leaf and keeps broad composition explicit', () => {
    const registry = manifest.createTestRegistry({ root: repository })
    const files = [...new Set(Object.values(ci.domainRules).flat())]
    const actual = focused.createFocusedPlan(
      ['--plan', ...files.flatMap((file) => ['--file', file])],
      {
        root: repository,
        entries: registry
      }
    )
    expect(actual.executed).toBe(false)
    expect(actual.selected).toHaveLength(files.length)
    expect(actual.selected.every((entry) => entry.role === 'test')).toBe(true)
    for (const entry of actual.selected) expect(entry.executionBlock, entry.file).toBeNull()
    const calendar = ci.selectCiTests({
      changedFiles: ['src/renderer/src/composables/useCalendarWorkspaceModel.js'],
      registry,
      platform: 'win32'
    })
    expect(calendar.selected.map((entry) => entry.file)).toEqual([
      'tests/calendar-workspace-model.test.js',
      'tests/calendar-workspace-electron.mjs'
    ])
    expect(calendar.exitCode).toBe(0)
    for (const file of [
      'src/main/unreviewed-entry.js',
      'src/preload/unreviewed.js',
      'src/shared/unreviewed-schema.js',
      'native_blur/unreviewed_api.cpp'
    ]) {
      expect(ci.selectCiTests({ changedFiles: [file], registry, platform: 'win32' })).toMatchObject(
        {
          state: 'needs-domain-validation',
          selected: [],
          exitCode: 3
        }
      )
    }
  })

  it('maps only existing registered tests, rather than accepting names created by a fixture', () => {
    const registry = manifest.createTestRegistry({ root: repository })
    const files = new Map(registry.map((entry) => [entry.file, entry]))
    for (const targets of [
      ...Object.values(ci.infrastructureRules),
      ...Object.values(ci.removedDesktopAssetRules),
      ...Object.values(ci.replacementProtectionRules),
      ...Object.values(ci.reviewedOptInChanges),
      ...Object.values(ci.domainRules)
    ]) {
      for (const target of targets) expect(files.get(target)?.role, target).toBe('test')
    }
  })

  it('retains selected runtime prerequisites so clean Windows CI can prepare native engines', () => {
    const registry = manifest.createTestRegistry({ root: repository })
    const result = ci.selectCiTests({
      changedFiles: ['src/main/index.js'],
      registry,
      platform: 'win32'
    })
    const selected = result.selected.flatMap((entry) => entry.runtimePrerequisites)
    expect(selected).toContain('capture-qt-deployment')
    expect(selected).toContain('blur-engine-abi-22')
    expect(result.selected.some((entry) => entry.requires.includes('build-app'))).toBe(true)
    const pureUnit = plan(['tests/arbitrary.test.js'])
    expect(pureUnit.selected.flatMap((entry) => entry.runtimePrerequisites)).toEqual([])
  })

  it('keeps the build descriptor suite in its own change scope with fixed consumer expectations', () => {
    const selected = plan(['scripts/test-build-descriptors.cjs'])
    expect(selected.selected.map((entry) => entry.file)).toEqual([
      'tests/test-build-descriptors.test.js',
      'tests/test-build-provenance.test.js',
      'tests/capture-build-selection.test.js'
    ])
  })

  it('never promotes source-read/import candidates into jobs', () => {
    const registry = fixtureRegistry()
    registry
      .find((entry) => entry.file === 'tests/arbitrary.test.js')
      .sourceReadDependencies.push('src/shared/arbitrary.js')
    const result = plan(['src/shared/arbitrary.js'], 'win32', registry)
    expect(result.selected).toEqual([])
    expect(result.candidates[0].ids).toEqual(['tests/arbitrary.test.js'])
    expect(result).toMatchObject({ state: 'needs-domain-validation', exitCode: 3 })
  })

  it('keeps the real motion benchmark explicit even with a verified standalone adapter', () => {
    const registry = manifest.createTestRegistry({ root: repository })
    const result = ci.selectCiTests({
      changedFiles: ['tests/logging-motion-overhead-electron.mjs'],
      registry,
      platform: 'win32'
    })
    expect(result.selected.map((entry) => entry.file)).toEqual(
      ci.reviewedOptInChanges['tests/logging-motion-overhead-electron.mjs']
    )
    expect(
      result.selected.some((entry) => entry.file === 'tests/logging-motion-overhead-electron.mjs')
    ).toBe(false)
    expect(result.noTestFiles[0].reason).toContain('benchmark remains explicit')
    expect(result.exitCode).toBe(0)
  })

  it('selects the reviewed real storage consumer on Windows', () => {
    expect(plan(['src/main/db/db-images.js']).selected.map((entry) => entry.file)).toEqual([
      'tests/attachment-storage-electron.mjs'
    ])
    expect(plan(['src/main/db/db-wallpapers.js']).selected.map((entry) => entry.file)).toEqual([
      'tests/wallpaper-storage-electron.mjs'
    ])
  })

  it('validates reviewed platform-asset removal but refuses reintroduction', () => {
    for (const [file, targets] of Object.entries(ci.removedDesktopAssetRules)) {
      const deletion = plan([{ file, status: 'D' }])
      expect(deletion.state).toBe('selected')
      expect(deletion.selected.map((entry) => entry.file)).toEqual(targets)
      expect(deletion.exitCode).toBe(0)
      for (const status of ['A', 'M', 'T']) {
        const reintroduction = plan([{ file, status }])
        expect(reintroduction.selected).toEqual([])
        expect(reintroduction.exitCode).toBe(3)
        expect(reintroduction.needsDomainValidation[0].reason).toContain('platform review')
      }
    }
  })

  it('rejects unmapped/runtime/deleted protection changes without full-suite fallback', () => {
    expect(plan(['src/preload/unreviewed.js'])).toMatchObject({
      state: 'needs-domain-validation',
      exitCode: 3
    })
    expect(plan(['package-lock.json']).unmapped).toHaveLength(1)
    expect(plan(['package.json']).needsDomainValidation[0].reason).toContain(
      'Package metadata/dependencies'
    )
    expect(
      plan([{ file: 'tests/arbitrary.test.js', status: 'D' }]).needsDomainValidation[0].reason
    ).toContain('replacement-protection')
    expect(plan(['src/main/db/db-images.js', 'src/shared/unknown.js']).exitCode).toBe(3)
    expect(plan(['docs/new-script.cjs']).unmapped).toHaveLength(1)
  })

  it('treats unavailable mapped consumers as an error and rejects escaping paths', () => {
    const registry = fixtureRegistry().filter(
      (entry) => entry.file !== 'tests/test-entrypoints.test.js'
    )
    expect(plan(['scripts/run-test-entry.cjs'], 'win32', registry).unmapped[0].reason).toContain(
      'unavailable test'
    )
    for (const file of ['../README.md', '/README.md', 'C:/file.js', 'a/../file.js', 'a\nfile.js'])
      expect(() => plan([file])).toThrow('repository-relative')
  })

  it('requires full nonzero baseline commits and does not reinterpret CLI options', () => {
    for (const baseSha of [undefined, '', 'HEAD~1', '0'.repeat(40), '--all'])
      expect(() => ci.collectCommittedChanges({ baseSha, headSha: '1'.repeat(40) })).toThrow(
        'nonzero full commit SHA'
      )
    expect(
      ci.parseCiArgs(['--plan'], {
        CI_TEST_BASE_SHA: 'a'.repeat(40),
        CI_TEST_HEAD_SHA: 'b'.repeat(40)
      })
    ).toMatchObject({ planOnly: true, baseSha: 'a'.repeat(40) })
    expect(() => ci.parseCiArgs(['--base'])).toThrow('incomplete')
    expect(() => ci.parseCiArgs(['--all'])).toThrow('Unknown')
  })

  it('diffs only committed changes, excluding dirty files, and validates history', () => {
    const root = mkdtempSync(join(tmpdir(), 'abandon-ci-scope-'))
    roots.push(root)
    const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    git(['init', '--initial-branch=main'])
    git(['config', 'user.email', 'scope-fixture@local.invalid'])
    git(['config', 'user.name', 'scope fixture'])
    writeFileSync(join(root, 'README.md'), 'first\n')
    git(['add', 'README.md'])
    git(['commit', '-m', 'first'])
    const baseSha = git(['rev-parse', 'HEAD'])
    writeFileSync(join(root, 'README.md'), 'second\n')
    git(['add', 'README.md'])
    git(['commit', '-m', 'second'])
    const headSha = git(['rev-parse', 'HEAD'])
    writeFileSync(join(root, 'dirty-shared.js'), 'never selected\n')
    expect(ci.collectCommittedChanges({ root, baseSha, headSha }).changedFiles).toEqual([
      { status: 'M', file: 'README.md' }
    ])
    expect(ci.collectCommittedChanges({ root, baseSha: headSha, headSha }).changedFiles).toEqual([])
    expect(() => ci.collectCommittedChanges({ root, baseSha: 'f'.repeat(40), headSha })).toThrow()
    git(['checkout', '-b', 'feature', baseSha])
    writeFileSync(join(root, 'feature.md'), 'feature only\n')
    git(['add', 'feature.md'])
    git(['commit', '-m', 'feature'])
    const featureSha = git(['rev-parse', 'HEAD'])
    const prRange = ci.collectCommittedChanges({
      root,
      baseSha: headSha,
      headSha: featureSha,
      baseMode: 'merge-base'
    })
    expect(prRange.effectiveBaseSha).toBe(baseSha)
    expect(prRange.changedFiles).toEqual([{ status: 'A', file: 'feature.md' }])
  })

  it('allows reviewed package script changes but refuses dependency changes', () => {
    const range = {
      changedFiles: [{ status: 'M', file: 'package.json' }],
      effectiveBaseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40)
    }
    const base = { name: 'fixture', scripts: { test: 'old' }, dependencies: { one: '1' } }
    const readVersion = (head) => (_command, args) =>
      JSON.stringify(args[1].startsWith('a') ? base : head)
    expect(
      ci.classifyPackageChange(range, {
        git: readVersion({ ...base, scripts: { test: 'precise' } })
      })
    ).toMatchObject({ scriptOnly: true })
    expect(
      ci.classifyPackageChange(range, { git: readVersion({ ...base, dependencies: { one: '2' } }) })
    ).toMatchObject({ scriptOnly: false })
    expect(
      ci.classifyPackageChange(range, {
        git: () => {
          throw new Error('missing base package')
        }
      })
    ).toMatchObject({ scriptOnly: false })
    expect(
      ci
        .selectCiTests({
          changedFiles: ['package.json'],
          registry: fixtureRegistry(),
          packageScriptOnly: true
        })
        .selected.map((entry) => entry.file)
    ).toEqual(ci.infrastructureRules['package.json'])
  })

  it('admits a valid version and script-only package bump while refusing metadata changes', () => {
    const range = {
      changedFiles: [{ status: 'M', file: 'package.json' }],
      effectiveBaseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40)
    }
    const base = { name: 'fixture', version: '1.3.0', scripts: {}, dependencies: { one: '1' } }
    const git = (head) => (_command, args) => JSON.stringify(args[1].startsWith('a') ? base : head)
    expect(
      ci.classifyPackageChange(range, {
        git: git({ ...base, version: '1.4.0', scripts: { test: 'precise' } })
      })
    ).toMatchObject({ versionAndScriptsOnly: true })
    expect(
      ci.classifyPackageChange(range, { git: git({ ...base, version: 'invalid' }) })
        .versionAndScriptsOnly
    ).not.toBe(true)
    expect(
      ci.classifyPackageChange(range, {
        git: git({ ...base, version: '1.4.0', dependencies: { one: '2' } })
      }).versionAndScriptsOnly
    ).not.toBe(true)
  })

  it('requires matching lockfile release versions and preserves the complete dependency graph', () => {
    const range = {
      changedFiles: [{ status: 'M', file: 'package-lock.json' }],
      effectiveBaseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40)
    }
    const lock = (version) => ({
      version,
      lockfileVersion: 3,
      packages: { '': { version }, 'node_modules/one': { version: '1.0.0', integrity: 'fixed' } }
    })
    const check = (head) =>
      ci.classifyLockfileChange(range, {
        git: (_command, args) => {
          if (args[1].endsWith(':package.json')) return JSON.stringify({ version: '1.4.0' })
          return JSON.stringify(args[1].startsWith('a') ? lock('1.3.0') : head)
        }
      })
    expect(check(lock('1.4.0')).versionOnly).toBe(true)
    expect(check(lock('1.3.0')).versionOnly).toBe(false)
    const altered = lock('1.4.0')
    altered.packages['node_modules/one'].integrity = 'changed'
    expect(check(altered).versionOnly).toBe(false)
    const admitted = ci.selectCiTests({
      changedFiles: ['package-lock.json'],
      registry: fixtureRegistry(),
      lockfileVersionOnly: true
    })
    expect(admitted.selected.map((entry) => entry.file)).toEqual(
      ci.infrastructureRules['package.json']
    )
    expect(plan(['package-lock.json']).state).toBe('needs-domain-validation')
  })

  it('reviews retired edge protection and keeps the opt-in toast probe explicitly manual', () => {
    const retired = plan([{ file: 'tests/dock-edge.test.js', status: 'D' }])
    expect(retired.exitCode).toBe(0)
    expect(retired.selected.map((entry) => entry.file)).toEqual(
      ci.replacementProtectionRules['tests/dock-edge.test.js']
    )
    const probe = plan(['tests/reminder-native-acceptance.cjs'])
    expect(probe.selected.map((entry) => entry.file)).toEqual(
      ci.reviewedOptInChanges['tests/reminder-native-acceptance.cjs']
    )
    expect(probe.noTestFiles[0].reason).toContain('remains manual')
    for (const file of Object.keys(ci.reviewedOptInChanges)) {
      expect(plan([{ file, status: 'D' }]).state).toBe('needs-domain-validation')
    }
  })

  it('downloads only the installer artifact into the flat release checksum directory', () => {
    const release = loadYaml(
      readFileSync(join(repository, '.github/workflows/release.yml'), 'utf8')
    )
    const upload = (job, name) =>
      job.steps.find(
        (step) => /^actions\/upload-artifact@/.test(step.uses || '') && step.with?.name === name
      )
    const installerUpload = upload(release.jobs.windows, 'abandon-note-windows-x64')
    const qualityUpload = upload(release.jobs.quality, 'release-quality-evidence')
    const downloads = release.jobs['draft-release'].steps.filter((step) =>
      /^actions\/download-artifact@/.test(step.uses || '')
    )

    expect(installerUpload.with.name).toBe('abandon-note-windows-x64')
    expect(installerUpload.with.path.trim().split(/\s*\n\s*/)).toEqual([
      'dist/Abandon-Note-*-windows-x64-setup.exe',
      'dist/Abandon-Note-*-windows-x64-setup.exe.blockmap',
      'dist/latest.yml'
    ])
    expect(downloads).toHaveLength(1)
    expect(downloads[0].with).toEqual({
      name: installerUpload.with.name,
      path: 'release-assets'
    })
    expect(downloads[0].with.name).not.toBe(qualityUpload.with.name)
    const checksums = release.jobs['draft-release'].steps.find((step) =>
      /sha256sum/.test(step.run || '')
    )
    expect(checksums['working-directory']).toBe(downloads[0].with.path)
  })

  it('keeps ordinary CI scoped and release responsibilities explicit', () => {
    const workflow = readFileSync(join(repository, '.github/workflows/ci.yml'), 'utf8')
    const release = readFileSync(join(repository, '.github/workflows/release.yml'), 'utf8')
    const pkg = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'))
    expect(workflow).toContain('fetch-depth: 0')
    expect(workflow).toContain('github.event.pull_request.base.sha')
    expect(workflow).toContain('github.event.before')
    expect(workflow).toContain('run: npm run test:ci')
    expect(workflow).toContain('runs-on: windows-latest')
    expect(workflow).toContain('architecture: x64')
    expect(workflow).not.toContain('macos-14')
    expect(workflow).not.toContain('matrix.os')
    expect(workflow).not.toContain('run: npm test')
    expect(workflow).not.toContain('test:window-frame:win')
    expect(workflow).not.toContain('build:native:win')
    const workflowData = loadYaml(workflow)
    const steps = workflowData.jobs.verify.steps
    expect(steps.find((step) => step.uses?.startsWith('jurplel/install-qt-action')).if).toBe(
      "steps.scope.outputs.capture == 'true'"
    )
    expect(steps.find((step) => step.run === 'npm run build:capture:win').if).toBe(
      "steps.scope.outputs.capture == 'true'"
    )
    expect(steps.find((step) => step.run?.includes('-File native_blur/build.ps1')).if).toBe(
      "steps.scope.outputs.native == 'true'"
    )
    expect(release).toContain('run: npm run test:release:quality')
    expect(release).toContain('test:window-frame:win')
    expect(release).toContain('--publish never')
    expect(release).toContain('gh release create')
    expect(pkg.scripts.test).toBe('node scripts/run-focused-tests.cjs')
    expect(pkg.scripts['test:unit']).toBe('node scripts/run-test-entry.cjs unit')
    expect(pkg.scripts['test:capture:native']).toBe(
      'node scripts/run-test-entry.cjs capture-native'
    )
    expect(pkg.scripts['test:daily-report:win']).toBe(
      'node scripts/run-focused-tests.cjs --file tests/daily-report-electron.mjs'
    )
  })
})
