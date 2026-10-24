import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import manifest from '../scripts/test-manifest.cjs'
import { NATIVE_ABI_VERSION } from '../src/shared/native-abi-version.js'

const nativeAbiPrerequisite = `blur-engine-abi-${NATIVE_ABI_VERSION}`

const normalize = (value) => value.replaceAll('\\', '/')
const root = resolve(import.meta.dirname, '..')
const initialRegistry = manifest.createTestRegistry({ root })
const registry = () => structuredClone(initialRegistry)
const validate = (entries, options = {}) =>
  manifest.validateTestRegistry(entries, { root, ...options })

function alteredEntry(file, changes = {}) {
  const entry = registry().find((asset) => asset.file === file)
  if (!entry) throw new Error('Missing test fixture registry entry: ' + file)
  return { ...entry, ...changes }
}

describe('test manifest', () => {
  it('records migrated owner inputs without inventing panel reads or product builds', () => {
    const entries = registry()
    const find = (file) => entries.find((entry) => entry.file === file)
    const owners = [
      'src/renderer/src/composables/useHolidayDataSettings.js',
      'src/renderer/src/composables/useSettingsDiagnostics.js'
    ]
    expect(find('tests/settings-panel-owners.test.js').sourceDependencies).toEqual(
      expect.arrayContaining(owners)
    )
    expect(find('tests/settings-panel-owners.test.js').sourceReadDependencies).toEqual([])
    const mounted = find('tests/settings-panel-owners-electron.mjs')
    expect(mounted.requires).toEqual([])
    expect(mounted.sourceDependencies).toEqual(
      expect.arrayContaining([
        ...owners,
        'tests/fixtures/settings-panel-owners/index.html',
        'tests/fixtures/settings-panel-owners/main.js'
      ])
    )
    const tags = find('tests/tag-commands-electron.mjs')
    expect(tags.requires).toEqual([])
    expect(tags.sourceDependencies).toEqual(
      expect.arrayContaining([
        'src/main/tags/tag-commands.js',
        'src/main/db/db-tags.js',
        'src/main/ipc/register-business-ipc.js'
      ])
    )
  })
  it('derives every native ABI prerequisite from the shared declaration exactly once', () => {
    const nativeEntries = registry().filter((entry) =>
      entry.runtimePrerequisites.some((name) => name.startsWith('blur-engine-abi-'))
    )
    expect(nativeEntries.length).toBeGreaterThan(0)
    for (const entry of nativeEntries) {
      expect(
        entry.runtimePrerequisites.filter((name) => name.startsWith('blur-engine-abi-'))
      ).toEqual([nativeAbiPrerequisite])
    }
  })
  it('classifies every mjs integration test or helper exactly once, including subdirectories', () => {
    const discovered = readdirSync(new URL('.', import.meta.url), { recursive: true })
      .map(normalize)
      .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
      .map((name) => `tests/${name}`)
      .sort()
    const registered = manifest.registeredMjsFiles.map(normalize).sort()

    expect(new Set(registered).size).toBe(registered.length)
    expect(registered).toEqual(discovered)
  })

  it('keeps runnable Electron groups separate from helpers and manual acceptance work', () => {
    const automated = new Set([
      ...manifest.databaseTests,
      ...manifest.storageTests,
      ...manifest.windowFrameTests,
      ...manifest.electronFeatureTests
    ])

    for (const path of [
      ...manifest.helperFiles,
      ...manifest.acceptanceTests,
      ...manifest.benchmarkTests
    ]) {
      expect(automated.has(path)).toBe(false)
    }
  })

  it('registers the discovered source assets with valid roles and prerequisites', () => {
    const entries = registry()
    expect(validate(entries)).toEqual([])
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
    expect(
      entries.every(
        (entry) => entry.cost === 'unmeasured' || (Number.isFinite(entry.cost) && entry.cost >= 0)
      )
    ).toBe(true)
    const reviewed = entries.filter((entry) => entry.disposition === 'reviewed-protection')
    expect(reviewed.length).toBeGreaterThan(0)
    for (const entry of reviewed) {
      expect(entry.contracts.length).toBeGreaterThan(0)
      expect(entry.features.length).toBeGreaterThan(0)
      expect(entry.limits).toContain('reviewed-scope-does-not-certify-current-pass')
      expect(entry.limits).not.toContain('behavior-contracts-unreviewed')
    }
    for (const entry of entries.filter((entry) => entry.disposition === 'unreviewed')) {
      expect(entry.contracts).toEqual([])
      expect(entry.limits).toContain('behavior-contracts-unreviewed')
    }
  })

  it('allows measured fixture costs while rejecting invalid numbers', () => {
    for (const cost of [0, 17.5, 'unmeasured']) {
      const entries = registry()
      entries[0].cost = cost
      expect(validate(entries)).toEqual([])
    }
    for (const cost of [-1, NaN, Infinity, '17.5']) {
      const entries = registry()
      entries[0].cost = cost
      expect(validate(entries)).toContain('Invalid cost: ' + entries[0].id)
    }
  })

  it('marks a newly discovered private unit fixture as unreviewed until its protection is audited', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'abandon-manifest-pending-'))
    try {
      mkdirSync(join(fixtureRoot, 'tests'))
      writeFileSync(join(fixtureRoot, 'tests/pending-fixture.test.js'), 'export {}\n')
      const entry = manifest
        .createTestRegistry({ root: fixtureRoot })
        .find((asset) => asset.file === 'tests/pending-fixture.test.js')
      expect(entry.disposition).toBe('unreviewed')
      expect(entry.contracts).toEqual([])
      expect(entry.limits).toContain('behavior-contracts-unreviewed')
      expect(entry.limits).not.toContain('reviewed-scope-does-not-certify-current-pass')
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('tracks the extracted z-order owner as the source-read dependency', () => {
    const entry = registry().find(
      (asset) => asset.file === 'tests/window-z-order-main-wiring.test.js'
    )
    expect(entry.sourceReadDependencies).toContain('src/main/windows/z-order-runtime.js')
    expect(entry.sourceReadDependencies).not.toContain('src/main/index.js')
  })

  it('keeps migrated source-read guards attached to the actual owners they read', () => {
    const byFile = new Map(registry().map((entry) => [entry.file, entry]))
    expect(byFile.get('tests/blur-settings-main-wiring.test.js').sourceReadDependencies).toEqual([
      'src/main/settings/settings-write-coordinator.js'
    ])
    expect(byFile.get('tests/view-switch-geometry-order.test.js').sourceReadDependencies).toContain(
      'src/main/windows/main-view-navigation.js'
    )
    expect(byFile.get('tests/dock-main-wiring.test.js').sourceReadDependencies).toEqual(
      expect.arrayContaining([
        'src/main/window-motion/dock-runtime.js',
        'src/main/windows/main-view-navigation.js',
        'src/main/capture/capture-window-integration.js'
      ])
    )
    expect(
      byFile.get('tests/presentation-mode-architecture.test.js').sourceReadDependencies
    ).toEqual(
      expect.arrayContaining([
        'src/main/windows/main-window-host.js',
        'src/main/windows/presentation-runtime.js',
        'src/main/windows/window-drag-controller.js',
        'src/main/windows/main-view-navigation.js',
        'src/main/settings/settings-write-coordinator.js',
        'src/main/window-motion/dock-runtime.js'
      ])
    )
  })

  it('registers each Vitest include match as a separate executable file', () => {
    const discovered = readdirSync(new URL('.', import.meta.url), { recursive: true })
      .map(normalize)
      .filter((name) => /\.test\.(js|mjs|ts)$/.test(name))
      .map((name) => 'tests/' + name)
      .sort()
    const actual = registry().filter((entry) => entry.runtime === 'vitest')
    expect(actual.map((entry) => entry.file).sort()).toEqual(discovered)
    expect(actual.every((entry) => entry.id === entry.file && entry.role === 'test')).toBe(true)
  })

  it('keeps startup lifecycle protection on the complete product owners and real prerequisites', () => {
    const entry = registry().find((asset) => asset.file === 'tests/main-view-startup-electron.mjs')
    expect(entry.features).toContain('main-view-startup')
    expect(entry.requires).toEqual(
      expect.arrayContaining(['build-app', 'build-native', 'build-capture'])
    )
    expect(entry.sourceDependencies).toEqual(
      expect.arrayContaining([
        'src/main/index.js',
        'src/main/windows/main-view-navigation.js',
        'src/main/services/notification-activation.js',
        'src/main/windows/editing-draft-guard.js',
        'src/main/settings/settings-write-source.js',
        'src/main/application/shutdown-coordinator.js'
      ])
    )
    expect(entry.runtimePrerequisites).toContain(nativeAbiPrerequisite)
  })

  it('keeps isolated report timezone checks as a support fixture owned by its explicit unit consumer', () => {
    const entries = registry()
    const fixture = entries.find(
      (entry) => entry.file === 'tests/fixtures/daily-report-timezone.mjs'
    )
    expect(fixture).toMatchObject({
      role: 'fixture',
      selectionPolicy: 'support',
      runtime: 'none',
      requires: [],
      runtimePrerequisites: []
    })
    const test = entries.find((entry) => entry.file === 'tests/daily-report.test.js')
    expect(test.sourceDependencies).toContain(fixture.file)
    expect(fixture.sourceDependencies).toContain('src/main/services/daily-report.js')
  })

  it('keeps support assets and explicit native/install acceptance work out of routine selection', () => {
    const entries = registry()
    for (const file of [
      'tests/helpers/reminder-activation.ps1',
      'tests/helpers/capture-owner.cjs',
      'tests/fixtures/notice-admin-server.py',
      'native_capture/tests/input_driver.cpp'
    ]) {
      const entry = entries.find((asset) => asset.file === file)
      expect(entry.selectionPolicy).toBe('support')
      expect(['helper', 'fixture']).toContain(entry.role)
    }
    for (const file of [
      'tests/sandbox-electron-win.ps1',
      'tests/capture-package-smoke.cjs',
      'native_capture/tests/clipboard_test.cpp'
    ]) {
      expect(entries.find((asset) => asset.file === file).selectionPolicy).toBe('explicit')
    }
  })

  it('reports both missing registrations and missing physical files', () => {
    const entries = registry()
    const errors = validate(
      entries.filter((entry) => entry.file !== 'tests/almanac-engine.test.js')
    )
    expect(errors).toContain('Unregistered discovered asset: tests/almanac-engine.test.js')
    const missing = alteredEntry('tests/almanac-engine.test.js', {
      id: 'missing-test',
      file: 'tests/missing-registry-fixture.test.js'
    })
    expect(validate([missing], { discoveredFiles: [] })).toContain(
      'Missing registered file: tests/missing-registry-fixture.test.js'
    )
  })

  it('reports unknown newly discovered helpers instead of guessing that they are tests', () => {
    const file = 'tests/helpers/new-unreviewed-helper.js'
    expect(validate(registry(), { discoveredFiles: [file] })).toContain(
      'Unregistered discovered asset: ' + file
    )
  })

  it('reports duplicate ids and files including Windows case variants', () => {
    const entry = alteredEntry('tests/almanac-engine.test.js')
    expect(validate([entry, { ...entry }], { discoveredFiles: [] })).toContain(
      'Duplicate id: ' + entry.id
    )
    expect(
      validate([entry, { ...entry, id: 'other', file: 'tests/ALMANAC-engine.test.js' }], {
        discoveredFiles: []
      })
    ).toContain('Duplicate file: tests/ALMANAC-engine.test.js')
  })

  it('rejects a fixture or helper disguised as an executable test', () => {
    for (const file of ['tests/fixtures/ui-components.vue', 'tests/helpers/capture-owner.cjs']) {
      const entry = alteredEntry(file, {
        role: 'test',
        level: 'gui',
        runtime: 'electron',
        selectionPolicy: 'focused'
      })
      expect(
        validate([entry], { discoveredFiles: [] }).some((error) =>
          error.startsWith('Wrong role for ' + file)
        )
      ).toBe(true)
    }
  })

  it('rejects unsafe paths before reading them', () => {
    for (const file of [
      '../outside.test.js',
      '/absolute.test.js',
      'C:/outside.test.js',
      'tests\\almanac-engine.test.js',
      'tests/./almanac-engine.test.js',
      'tests//almanac-engine.test.js'
    ]) {
      const entry = alteredEntry('tests/almanac-engine.test.js', { file })
      expect(validate([entry], { discoveredFiles: [] })).toContain(
        'Unsafe repository path: ' + file
      )
    }
    const entry = alteredEntry('tests/almanac-engine.test.js', {
      sourceReadDependencies: ['../outside.js']
    })
    expect(validate([entry], { discoveredFiles: [] })).toContain(
      'Unsafe sourceReadDependencies path: ' + entry.id + ': ../outside.js'
    )
  })

  it('rejects a repository-relative symlink whose real file is outside the repository', () => {
    const directory = mkdtempSync(join(tmpdir(), 'abandon-registry-link-'))
    const external = join(directory, 'external')
    const owned = join(directory, 'owned')
    // Directory junctions work for ordinary Windows users without symlink privilege.
    mkdirSync(owned)
    mkdirSync(external)
    writeFileSync(join(external, 'escaped.test.js'), '// outside fixture\n')
    const link = join(owned, 'tests')
    try {
      symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
      const entry = alteredEntry('tests/almanac-engine.test.js', {
        id: 'escaped',
        file: 'tests/escaped.test.js',
        sourceDependencies: [],
        sourceReadDependencies: []
      })
      expect(
        manifest.validateTestRegistry([entry], { root: owned, discoveredFiles: [] })
      ).toContain('Registered file escapes repository: tests/escaped.test.js')
    } finally {
      // Only the exact private mkdtemp fixture and its owned link are removed.
      if (existsSync(link)) {
        if (process.platform === 'win32') rmdirSync(link)
        else unlinkSync(link)
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects unknown, support-asset and cyclic build dependencies', () => {
    const unit = alteredEntry('tests/almanac-engine.test.js', { requires: ['missing-build'] })
    expect(validate([unit], { discoveredFiles: [] })).toContain(
      'Unknown dependency: ' + unit.id + ' -> missing-build'
    )
    const helper = alteredEntry('tests/helpers/capture-owner.cjs')
    const unsupported = { ...unit, requires: [helper.id] }
    expect(validate([unsupported, helper], { discoveredFiles: [] })).toContain(
      'Dependency is not a build: ' + unit.id + ' -> ' + helper.id
    )
    const app = alteredEntry('electron.vite.config.mjs', { requires: ['build-capture'] })
    const capture = alteredEntry('native_capture/build.ps1', { requires: ['build-app'] })
    expect(
      validate([app, capture], { discoveredFiles: [] }).some((error) =>
        error.startsWith('Dependency cycle: ')
      )
    ).toBe(true)
  })

  it('keeps recovery reports on direct-source tests without application builds', () => {
    for (const file of [
      'tests/attachment-reset-recovery.test.js',
      'tests/attachment-storage-electron.mjs',
      'tests/attachment-recovery-reset-electron.mjs'
    ]) {
      const entry = registry().find((candidate) => candidate.file === file)
      expect(entry.requires).toEqual([])
      expect(entry.features).toContain('attachment-recovery-report')
      expect(entry.sourceDependencies).toEqual(
        expect.arrayContaining([
          'src/main/db/attachment-recovery.js',
          'src/main/db/attachment-recovery-report.js'
        ])
      )
      if (entry.runtime === 'electron')
        expect(entry.sourceDependencies).toContain('src/main/db/db.js')
    }
  })

  it('maps attachment diagnostics to the actual component and transport without UI-unit builds', () => {
    const find = (file) => registry().find((entry) => entry.file === file)
    const component = 'src/renderer/src/components/system/settings/AttachmentRecoveryStatus.vue'
    const ui = find('tests/attachment-recovery-status.test.js')
    expect(ui.requires).toEqual([])
    expect(ui.features).toContain('attachment-recovery-diagnostics')
    expect(ui.sourceDependencies).toContain(component)
    const product = find('tests/logging-actions-electron.mjs')
    expect(product.sourceDependencies).toEqual(
      expect.arrayContaining([
        component,
        'src/preload/index.js',
        'src/main/db/db.js',
        'src/main/ipc/register-logging-ipc.js'
      ])
    )
    expect(product.requires).toContain('build-app')
  })

  it('keeps controlled recovery on explicit transport, business and storage consumers', () => {
    const find = (file) => registry().find((entry) => entry.file === file)
    const controller = 'src/main/application/attachment-recovery-retry.js'
    for (const file of [
      'tests/attachment-recovery-retry.test.js',
      'tests/attachment-storage-electron.mjs'
    ]) {
      const entry = find(file)
      expect(entry.requires).toEqual([])
      expect(entry.features).toContain('attachment-recovery-retry')
      expect(entry.sourceDependencies).toContain(controller)
      expect(entry.sourceDependencies).toContain(
        'src/main/application/business-mutation-admission.js'
      )
    }
    expect(find('tests/logging-actions-electron.mjs').sourceDependencies).toEqual(
      expect.arrayContaining([
        controller,
        'src/main/drafts/session-draft-assets-runtime.js',
        'src/preload/index.js'
      ])
    )
  })

  it('keeps migration backup contracts on direct database tests without app builds', () => {
    const entries = registry()
    for (const file of [
      'tests/database-migration-backup-electron.mjs',
      'tests/database-runtime-db.mjs',
      'tests/backend-integration.mjs'
    ]) {
      const entry = entries.find((candidate) => candidate.file === file)
      expect(entry.requires).toEqual([])
      expect(entry.features).toContain('database-migration-backup')
      expect(entry.sourceDependencies).toContain('src/main/db/db-migration-backup.js')
    }
  })

  it('registers the image decode budget with only its bootstrap build dependency', () => {
    const entries = registry()
    const find = (file) => entries.find((entry) => entry.file === file)
    for (const file of [
      'tests/image-decode-budget.test.js',
      'tests/image-decode-runtime.test.js'
    ]) {
      expect(find(file).requires).toEqual([])
      expect(find(file).features).toContain('attachment-image-decode-budget')
    }
    expect(find('tests/image-decode-electron.mjs')).toMatchObject({
      runtime: 'electron',
      requires: ['build-app']
    })
    expect(find('tests/image-decode-electron.mjs').features).toContain(
      'attachment-image-decode-budget'
    )
  })

  it('keeps actual build inputs separate from native runtime prerequisites', () => {
    const entries = registry()
    const find = (file) => entries.find((entry) => entry.file === file)
    expect(find('tests/attachment-storage-electron.mjs').requires).toEqual([])
    expect(find('tests/window-z-order-electron.mjs').requires).toEqual(['build-native'])
    expect(find('tests/capture-host-electron.mjs').requires).toEqual(['build-capture'])
    expect(find('tests/capture-host-electron.mjs').requires).not.toContain('build-app')
    expect(find('tests/capture-lifecycle-electron.mjs').requires).toEqual(['build-capture'])
    expect(find('tests/capture-compositor-electron.mjs').requires).toEqual(
      expect.arrayContaining(['build-app', 'build-native', 'build-capture'])
    )
    expect(find('tests/capture-compositor-electron.mjs').runtimePrerequisites).toEqual(
      expect.arrayContaining([nativeAbiPrerequisite, 'same-build-capture-input-driver'])
    )
    expect(find('tests/capture-compositor-electron.mjs').sourceDependencies).toEqual(
      expect.arrayContaining([
        'src/main/capture/CaptureCoordinator.js',
        'src/main/capture/capture-window-integration.js',
        'scripts/prototypes/show-desktop/win32.cjs',
        'native_capture/tests/input_driver.cpp'
      ])
    )
    for (const file of [
      'tests/capture-host-electron.mjs',
      'tests/capture-lifecycle-electron.mjs'
    ]) {
      expect(find(file).runtimePrerequisites).toContain('owned-isolated-profile')
      expect(find(file).sourceDependencies).toEqual(
        expect.arrayContaining([
          'src/main/capture/CaptureHost.js',
          'tests/helpers/capture-owner.cjs',
          'tests/helpers/test-result-recorder.cjs'
        ])
      )
    }
    expect(find('tests/capture-host-electron.mjs').runtimePrerequisites).not.toContain(
      'windows-desktop'
    )
    expect(find('tests/capture-lifecycle-electron.mjs').runtimePrerequisites).toContain(
      'windows-desktop'
    )
    expect(find('tests/capture-lifecycle-electron.mjs').sourceDependencies).toContain(
      'tests/helpers/capture-test-desktop.mjs'
    )
    expect(find('tests/capture-business-electron.mjs').requires).toContain('build-app')
    expect(find('tests/capture-delivery-electron.mjs').requires).toEqual(
      expect.arrayContaining(['build-app', 'build-native', 'build-capture'])
    )
    expect(find('tests/capture-delivery-electron.mjs').runtimePrerequisites).toContain(
      nativeAbiPrerequisite
    )
    expect(find('tests/note-list-toolbar-electron.mjs').requires).toEqual(['build-app'])
    expect(find('tests/dock-runtime-electron.mjs').requires).toEqual([
      'build-app',
      'build-native',
      'build-capture'
    ])
    expect(find('tests/calendar-workspace-electron.mjs').requires).toEqual(['build-app'])
    expect(find('tests/reminder-initialization-electron.mjs')).toMatchObject({
      runtime: 'electron',
      requires: ['build-app']
    })
    expect(find('tests/reminder-initialization-electron.mjs').runtimePrerequisites).not.toContain(
      'capture-qt-deployment'
    )
    expect(find('tests/background-navigation-electron.mjs').requires).toEqual(
      expect.arrayContaining(['build-native', 'build-app'])
    )
    expect(find('tests/background-navigation-electron.mjs').runtimePrerequisites).toContain(
      nativeAbiPrerequisite
    )
    for (const file of [
      'tests/reminders-electron.mjs',
      'tests/daily-report-electron.mjs',
      'tests/settings-runtime-electron.mjs',
      'tests/settings-queue-electron.mjs',
      'tests/settings-snapshot-ordering-electron.mjs',
      'tests/note-list-custom-electron.mjs',
      'tests/recurring-preview-electron.mjs',
      'tests/native-leaf-runtime-electron.mjs',
      'tests/dock-runtime-electron.mjs',
      'tests/application-lifecycle-electron.mjs'
    ]) {
      expect(find(file).requires).toHaveLength(3)
      expect(find(file).requires).toEqual(
        expect.arrayContaining(['build-app', 'build-native', 'build-capture'])
      )
      expect(find(file).runtimePrerequisites).toContain(nativeAbiPrerequisite)
    }
    expect(find('tests/logging-motion-overhead-electron.mjs')).toMatchObject({
      level: 'performance',
      runtime: 'electron',
      selectionPolicy: 'explicit',
      requires: ['build-app', 'build-native', 'build-capture']
    })
    expect(find('tests/business-clear-admission-electron.mjs').requires).toEqual([])
    expect(find('tests/business-clear-admission-electron.mjs').runtimePrerequisites).toContain(
      'electron-abi-compatible-better-sqlite3'
    )
    expect(find('tests/note-list-toolbar-electron.mjs').runtimePrerequisites).toContain(
      'capture-qt-deployment'
    )
    expect(find('electron.vite.config.mjs').buildInputs).toContain('src/main')
    expect(find('tests/note-draft-conflict-electron.mjs')).toMatchObject({
      level: 'database',
      runtime: 'electron',
      requires: []
    })
    expect(find('tests/capture-host-electron.mjs')).toMatchObject({
      level: 'native',
      runtime: 'electron'
    })
    expect(find('tests/capture-host-electron.mjs').limits).toContain(
      'background-helper-lifecycle-no-capture-overlay-or-real-input'
    )
    expect(find('tests/thumbnail-benchmark-electron.mjs').runtimePrerequisites).toContain(
      'electron-runtime'
    )
  })

  it('registers the isolated renderer fixture without product main or native prerequisites', () => {
    const entries = registry()
    const find = (file) => entries.find((entry) => entry.file === file)
    const file = 'tests/renderer-resource-lifetime-electron.mjs'
    expect(manifest.registeredMjsFiles.filter((registered) => registered === file)).toEqual([file])
    expect(find(file)).toMatchObject({
      role: 'test',
      level: 'gui',
      runtime: 'electron',
      requires: [],
      runtimePrerequisites: ['electron-runtime']
    })
    expect(find(file).sourceDependencies).toEqual(
      expect.arrayContaining([
        'src/renderer/src/components/note/ImagePicker.vue',
        'src/renderer/src/components/note/ImagePreview.vue'
      ])
    )
    for (const name of ['index.html', 'main.js', 'preload.cjs']) {
      const fixture = 'tests/fixtures/renderer-resource-lifetime/' + name
      expect(find(fixture)).toMatchObject({
        role: 'fixture',
        level: 'support',
        runtime: 'none',
        selectionPolicy: 'support'
      })
      expect(find(file).sourceDependencies).toContain(fixture)
    }
    expect(find('tests/helpers/electron-gui-result-lifecycle.mjs')).toMatchObject({
      role: 'helper',
      selectionPolicy: 'support'
    })
  })

  it('records verified source text and dynamic helper consumers without relying on import graphs', () => {
    const entries = registry()
    const find = (file) => entries.find((entry) => entry.file === file)
    expect(find('tests/recent-local-day-range.test.js').sourceReadDependencies).toContain(
      'src/renderer/src/components/list/SearchBox.vue'
    )
    expect(find('tests/recent-local-day-range.test.js').sourceDependencies).toContain(
      'src/shared/calendar/calendar-date-rules.js'
    )
    expect(find('tests/dock-trigger-electron.mjs').sourceDependencies).toContain(
      'tests/fullscreen-foreground-electron.mjs'
    )
    expect(find('tests/ui-z-index.test.js').sourceReadDependencies).toContain(
      'src/renderer/src/components/list/NoteList.vue'
    )
    expect(find('tests/ui-z-index.test.js').directoryReadDependencies).toEqual([
      { directory: 'src/renderer', extensions: ['.css', '.js', '.vue'] }
    ])
  })

  it('declares the five security entries with the correct three preload capabilities', () => {
    const entries = manifest.securityEntryPoints
    expect(entries.map((entry) => entry.html)).toEqual([
      'src/renderer/index.html',
      'src/renderer/month.html',
      'src/renderer/week.html',
      'src/renderer/sticky.html',
      'src/renderer/reminder.html'
    ])
    expect(new Set(entries.map((entry) => entry.preload)).size).toBe(3)
    for (const entry of entries) {
      expect(existsSync(resolve(root, entry.html))).toBe(true)
      expect(existsSync(resolve(root, entry.preload))).toBe(true)
    }
    expect(entries.find((entry) => entry.capability === 'reminder').preload).toBe(
      'src/preload/reminder.js'
    )
    expect(alteredEntry('tests/security-hardening.test.js').sourceReadDependencies).toContain(
      'src/renderer/reminder.html'
    )
  })

  it('parses actual import declarations without mistaking embedded fixture source for imports', () => {
    const directory = mkdtempSync(join(tmpdir(), 'abandon-registry-import-'))
    mkdirSync(join(directory, 'tests'))
    writeFileSync(join(directory, 'tests', 'actual.js'), 'export default 1\n')
    writeFileSync(
      join(directory, 'tests', 'ast.test.ts'),
      [
        "import actual from './actual.js'",
        'const typed: number = actual',
        'const fixtureSource = `',
        "import ignored from './embedded-only.js'",
        '`',
        'void typed; void fixtureSource'
      ].join('\n')
    )
    try {
      const entry = manifest
        .createTestRegistry({ root: directory })
        .find((asset) => asset.file === 'tests/ast.test.ts')
      expect(entry.sourceDependencies).toEqual(['tests/actual.js'])
      expect(entry.runtime).toBe('vitest')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses to enumerate or parse an external directory junction during registry discovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'abandon-registry-discovery-link-'))
    const owned = join(directory, 'owned')
    const external = join(directory, 'external')
    mkdirSync(owned)
    mkdirSync(external)
    // Invalid source makes accidental parsing fail before an integrity report.
    writeFileSync(join(external, 'escaped.test.js'), 'import this is deliberately invalid')
    writeFileSync(join(external, 'build-notice-preview.mjs'), 'import this is also invalid')
    const link = join(owned, 'tests')
    const sourceLink = join(owned, 'scripts')
    try {
      symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
      symlinkSync(external, sourceLink, process.platform === 'win32' ? 'junction' : 'dir')
      const entries = manifest.createTestRegistry({ root: owned })
      expect(entries.some((entry) => entry.file === 'tests/escaped.test.js')).toBe(false)
      const errors = manifest.validateTestRegistry(entries, { root: owned })
      expect(errors).toContain('Unregistered discovered asset: tests')
      expect(errors).toContain(
        'Registered file escapes repository: scripts/build-notice-preview.mjs'
      )
    } finally {
      for (const ownedLink of [link, sourceLink]) {
        if (existsSync(ownedLink)) {
          if (process.platform === 'win32') rmdirSync(ownedLink)
          else unlinkSync(ownedLink)
        }
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
