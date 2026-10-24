import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import descriptors from '../scripts/test-build-descriptors.cjs'

const { describeBuild } = descriptors
const temporaryDirectories = []

function file(root, name, contents) {
  const target = join(root, name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
  return target
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'abandon-build-descriptor-unit-'))
  temporaryDirectories.push(root)
  file(root, 'src/shared/native-abi-version.js', 'export const NATIVE_ABI_VERSION = 18\n')
  file(root, 'native_capture/CMakeLists.txt', 'fixture capture CMake config')
  file(root, 'native_capture/build.ps1', 'fixture build')
  file(root, 'native_capture/run-qt-test.cmake', 'fixture wrapper')
  file(root, 'native_capture/engine/main.cpp', 'fixture C++')
  file(root, 'native_capture/tests/core_test.cpp', 'fixture QTest')
  file(root, 'native_capture/deploy/old.exe', 'old output must not be treated as source')
  file(root, 'native_blur/CMakeLists.txt', 'fixture blur CMake config')
  file(root, 'native_blur/build.ps1', 'fixture build')
  file(root, 'native_blur/resources/icon.png', 'fixture resource')
  file(root, 'native_blur/blur_api.cpp', 'fixture source')
  return root
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory)
    expect(target.startsWith(resolve(tmpdir()) + sep)).toBe(true)
    expect(relative(tmpdir(), target).startsWith('abandon-build-descriptor-unit-')).toBe(true)
    rmSync(target, { recursive: true, force: true })
  }
})

describe('reviewed build descriptors', () => {
  it('keeps the complete app dependency tree and root environment additions in the next snapshot', () => {
    const root = fixture()
    const options = { root, id: 'build-app', env: { PATH: 'fixture', TOKEN: 'private-value' } }
    const initial = describeBuild(options)
    expect(initial.snapshotOptions.inputs).toEqual([
      'src',
      'resources',
      'package.json',
      'package-lock.json',
      'node_modules',
      'electron.vite.config.mjs'
    ])
    expect(initial.command).toBe(process.execPath)
    expect(initial.args).toEqual(['node_modules/electron-vite/bin/electron-vite.js', 'build'])
    expect(initial.snapshotOptions.closure.complete).toBe(true)
    expect(JSON.stringify(initial)).not.toContain('private-value')
    file(root, '.env.production', 'VITE_RELEASE=fixture')
    const current = describeBuild(options)
    expect(current.snapshotOptions.inputs).toContain('.env.production')
    expect(current.outputs).toContain('out/main/index.js')
    expect(current.outputs).toContain('out/preload/index.js')
    expect(current.outputs).toContain('out/renderer/index.html')
  })

  it('rejects unknown external Node injection from reusable closure while binding ambient env changes', () => {
    const root = fixture()
    const normal = describeBuild({ root, id: 'build-app', env: { VITE_FEATURE: 'a' } })
    const changed = describeBuild({ root, id: 'build-app', env: { VITE_FEATURE: 'b' } })
    expect(normal.snapshotOptions.mode.environmentDigest).not.toBe(
      changed.snapshotOptions.mode.environmentDigest
    )
    const injected = describeBuild({
      root,
      id: 'build-app',
      env: { NODE_OPTIONS: '--require external' }
    })
    expect(injected.snapshotOptions.closure.complete).toBe(false)
    expect(injected.snapshotOptions.closure.basis).toContain('NODE_OPTIONS')
    expect(JSON.stringify(injected)).not.toContain('--require external')
  })

  it('keeps notice build outputs separate while covering shared renderer sources', () => {
    const root = fixture()
    const descriptor = describeBuild({ root, id: 'build-notice-preview', env: {} })
    expect(descriptor.args).toEqual(['scripts/build-notice-preview.mjs'])
    expect(descriptor.snapshotOptions.inputs).toContain('src')
    expect(descriptor.snapshotOptions.inputs).toContain('tools/notice-preview')
    expect(descriptor.outputs).toEqual([
      'tmp/notice-preview-dist',
      'tmp/notice-preview-dist/index.html',
      'tmp/notice-preview-dist/source-manifest.json'
    ])
  })

  it('only requests explicit Qt targets and binds their sorted names into a private build mode', () => {
    const root = fixture()
    const env = {}
    const descriptor = describeBuild({
      root,
      id: 'build-capture',
      qtNames: ['capture_ui', 'capture_core'],
      env
    })
    const reordered = describeBuild({
      root,
      id: 'build-capture',
      qtNames: ['capture_core', 'capture_ui'],
      env
    })
    const other = describeBuild({ root, id: 'build-capture', qtNames: ['capture_selection'], env })
    expect(descriptor.buildDirectory).toBe(reordered.buildDirectory)
    expect(descriptor.buildDirectory).not.toBe(other.buildDirectory)
    expect(relative(root, descriptor.buildDirectory).replaceAll('\\', '/')).toMatch(
      /^tmp\/focused-builds\/capture-[a-f0-9]{12}$/
    )
    expect(descriptor.args).toContain('-TestsOnly')
    expect(descriptor.args.slice(descriptor.args.indexOf('-TestName'))).toEqual([
      '-TestName',
      'capture_core,capture_ui'
    ])
    expect(descriptor.snapshotOptions.mode.qtNames).toEqual(['capture_core', 'capture_ui'])
    expect(descriptor.snapshotOptions.mode.product).toBe(false)
    expect(descriptor.snapshotOptions.inputs).toContain('native_capture/run-qt-test.cmake')
    expect(descriptor.snapshotOptions.inputs).not.toContain('native_capture/deploy')
    expect(descriptor.outputs.some((name) => name.includes('native_capture/deploy'))).toBe(false)
    expect(descriptor.outputs.some((name) => name.endsWith('/capture_core_tests.exe'))).toBe(true)
  })

  it('never treats a cached CMake executable as the complete MSVC, SDK or Qt closure', () => {
    const root = fixture()
    const tool = file(root, 'tools/cmake.exe', 'fixture executable')
    file(root, 'native_capture/build/CMakeCache.txt', 'CMAKE_COMMAND:INTERNAL=' + tool + '\n')
    const descriptor = describeBuild({ root, id: 'build-capture', env: {} })
    expect(descriptor.snapshotOptions.toolchain.files).toContainEqual({ name: 'cmake', path: tool })
    expect(descriptor.snapshotOptions.closure.complete).toBe(false)
    expect(descriptor.snapshotOptions.closure.basis).toContain('compiler/SDK headers/libraries')
    expect(descriptor.outputs).toEqual([
      'native_capture/deploy',
      'native_capture/deploy/AbandonCapture.exe',
      'native_capture/deploy/capture_host.dll'
    ])
  })

  it('includes blur resources and requires actual probe evidence independently of its ABI declaration', () => {
    const root = fixture()
    const descriptor = describeBuild({ root, id: 'build-native', env: {} })
    expect(descriptor.snapshotOptions.inputs).toContain('native_blur/resources')
    expect(descriptor.snapshotOptions.abi).toEqual({ declared: 18, validation: 'declaration-only' })
    expect(descriptor.requireValidation).toBe('native-runtime-probe')
    expect(descriptor.snapshotOptions.closure.complete).toBe(false)
  })

  it('builds capture deployment and the acceptance input driver in one explicit target invocation', () => {
    const root = fixture()
    const descriptor = describeBuild({ root, id: 'build-capture', inputDriver: true, env: {} })
    expect(descriptor.args).toContain('-InputDriver')
    expect(descriptor.args).not.toContain('-TestsOnly')
    expect(descriptor.outputs).toEqual(
      expect.arrayContaining([
        'native_capture/deploy',
        'native_capture/deploy/AbandonCapture.exe',
        'native_capture/deploy/capture_host.dll',
        relative(root, descriptor.inputDriverPath).replaceAll('\\', '/')
      ])
    )
    expect(descriptor.snapshotOptions.mode.inputDriver).toBe(true)
    expect(descriptor.snapshotOptions.closure.complete).toBe(false)
  })
  it('keeps deployment, selected Qt targets and the input driver together in a combined build', () => {
    const root = fixture()
    const descriptor = describeBuild({
      root,
      id: 'build-capture',
      qtNames: ['capture_core'],
      inputDriver: true,
      env: {}
    })
    expect(descriptor.args).toContain('-Test')
    expect(descriptor.args).toContain('-InputDriver')
    expect(descriptor.args).not.toContain('-TestsOnly')
    expect(descriptor.args.slice(descriptor.args.indexOf('-TestName'), -1)).toEqual([
      '-TestName',
      'capture_core'
    ])
    expect(descriptor.outputs).toEqual(
      expect.arrayContaining([
        'native_capture/deploy/AbandonCapture.exe',
        'native_capture/deploy/capture_host.dll',
        relative(root, descriptor.inputDriverPath).replaceAll('\\', '/'),
        relative(root, join(descriptor.buildDirectory, 'bin/capture_core_tests.exe')).replaceAll(
          '\\',
          '/'
        )
      ])
    )
    expect(descriptor.snapshotOptions.mode.product).toBe(true)
    expect(descriptor.snapshotOptions.mode.qtNames).toEqual(['capture_core'])
  })

  it('refuses unknown, duplicate and misplaced Qt names instead of widening to all targets', () => {
    const root = fixture()
    for (const qtNames of [['unknown'], ['capture_core', 'capture_core']])
      expect(() => describeBuild({ root, id: 'build-capture', qtNames, env: {} })).toThrow()
    expect(() =>
      describeBuild({ root, id: 'build-app', qtNames: ['capture_core'], env: {} })
    ).toThrow()
    expect(() => describeBuild({ root, id: 'unknown', env: {} })).toThrow()
  })
})
