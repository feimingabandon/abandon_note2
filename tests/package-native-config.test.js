import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Arch } from 'builder-util'
import { NATIVE_ABI_VERSION } from '../src/shared/native-abi-version.js'

const require = createRequire(import.meta.url)
const { createPackageWithOptions } = require('@electron/asar')
const { AppInfo, WinPackager } = require('app-builder-lib')
const {
  default: configurePackagedNative,
  collectFilePatterns
} = require('../scripts/configure-packaged-native.cjs')
const { NATIVE_TARGETS, resolveNativeTarget } = require('../scripts/package-native-plan.cjs')
const {
  default: validatePackagedApp,
  captureRuntimeFiles
} = require('../scripts/validate-packaged-app.cjs')

const temporaryRoots = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function writeFixture(root, relativePath, content = 'fixture') {
  const target = path.join(root, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
  return target
}

async function createPackagedFixture(
  platform,
  arch,
  {
    breakAsar = false,
    leakOutput = false,
    leakSource = false,
    leakDirectory = null,
    nativeFiles = [],
    unpackNative = true
  } = {}
) {
  const root = await mkdtemp(path.join(tmpdir(), 'abandon-package-native-'))
  temporaryRoots.push(root)
  const appSource = path.join(root, 'app-source')
  const resourcesDir = path.join(root, 'resources')
  const target = resolveNativeTarget({ electronPlatformName: platform, arch: Arch[arch] })

  await writeFixture(appSource, 'package.json', '{"name":"package-fixture"}')
  await writeFixture(appSource, 'out/preload/reminder.js')
  await writeFixture(appSource, 'out/renderer/reminder.html')
  for (const relativePath of target.required) {
    await writeFixture(appSource, path.join('node_modules', relativePath))
  }
  for (const relativePath of nativeFiles)
    await writeFixture(appSource, path.join('node_modules', relativePath))
  await writeFixture(appSource, path.join('resources', 'icon.png'))
  if (leakSource) {
    await writeFixture(appSource, path.join('src', 'main.js'), 'console.log("leaked")')
  }
  if (leakOutput) {
    await writeFixture(appSource, path.join('output', 'marketing', 'promo.png'))
  }
  if (leakDirectory) await writeFixture(appSource, path.join(leakDirectory, 'audit.json'))
  await mkdir(resourcesDir, { recursive: true })
  await createPackageWithOptions(appSource, path.join(resourcesDir, 'app.asar'), {
    ...(unpackNative ? { unpack: '*.node' } : {}),
    unpackDir: 'resources'
  })

  await writeFixture(resourcesDir, path.join('native_blur', 'blur_engine.dll'))
  for (const file of captureRuntimeFiles)
    await writeFixture(resourcesDir, path.join('native_capture', file))
  if (!unpackNative) {
    // 为 ASAR 内二进制负例准备目标文件，确保先命中白名单断言，而非缺 DLL/模块。
    for (const relativePath of target.required)
      await writeFixture(resourcesDir, path.join('app.asar.unpacked/node_modules', relativePath))
  }
  if (breakAsar) {
    await rm(path.join(resourcesDir, 'app.asar.unpacked', 'resources', 'icon.png'))
  }

  return {
    appOutDir: root,
    arch: Arch[arch],
    electronPlatformName: platform,
    packager: {
      config: { files: [{ filter: ['**/*'] }] },
      getResourcesDir: () => resourcesDir
    }
  }
}

describe('Windows publisher metadata', () => {
  async function loadMetadata(configName = 'electron-builder.win.yml') {
    const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config')
    const { readPackageJson } = require('app-builder-lib/out/util/packageMetadata')
    const root = path.resolve(import.meta.dirname, '..')
    const metadata = await readPackageJson(path.join(root, 'package.json'))
    const config = await getConfig(root, path.join(root, configName))
    await validateConfiguration(config, { isEnabled: false })
    return { metadata, config, appInfo: new AppInfo({ metadata, config }, undefined, config.win) }
  }

  it.each(['electron-builder.win.yml', 'electron-builder.yml'])(
    'resolves %s to the display publisher while preserving upgrade and repository identities',
    async (configName) => {
      const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget')
      const { metadata, config, appInfo } = await loadMetadata(configName)
      expect(metadata.author.name).toBe('炁体源流')
      expect(appInfo.companyName).toBe('炁体源流')
      expect(appInfo.copyright).toBe('Copyright © 2026 炁体源流')
      expect(appInfo.id).toBe('com.abandon.note')
      expect(config.nsis.guid).toBe('41249b74-bbe0-5d8d-8a9d-7f1bd6f04a19')
      expect(metadata.homepage).toBe('https://github.com/feimingabandon/abandon_note2')
      expect(metadata.repository.url).toBe(
        'git+https://github.com/feimingabandon/abandon_note2.git'
      )
      // Certificate publisher names identify real signers; display metadata cannot supply one.
      expect(config.win.publisherName).toBeUndefined()
      expect(config.win.signtoolOptions?.publisherName).toBeUndefined()
      expect(config.win.azureSignOptions?.publisherName).toBeUndefined()
      const defines = {}
      NsisTarget.prototype.configureDefinesForAllTypeOfInstaller.call(
        { packager: { appInfo }, options: config.nsis, isWebInstaller: false },
        defines
      )
      expect(defines.COMPANY_NAME).toBe('炁体源流')
      const template = readFileSync(
        require.resolve('app-builder-lib/templates/nsis/include/installer.nsh'),
        'utf8'
      )
      expect(template).toContain(
        'WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "Publisher" "${COMPANY_NAME}"'
      )
    }
  )

  it('passes the display publisher and copyright to the real Windows PE resource editor', async () => {
    const resourceEditor = require('app-builder-lib/out/util/resEdit')
    const { config, appInfo } = await loadMetadata()
    const edit = vi.spyOn(resourceEditor, 'editWindowsResources').mockResolvedValue(undefined)
    try {
      await WinPackager.prototype.signAndEditResources.call(
        {
          appInfo,
          // Disable executable cache discovery: this probe only observes resource-editor inputs.
          config: { ...config, electronDist: 'metadata-only-probe' },
          platformSpecificBuildOptions: config.win,
          getIconPath: async () => null,
          signIf: vi.fn(async () => false)
        },
        'metadata-only.exe',
        Arch.x64,
        'metadata-only-output'
      )
      expect(edit).toHaveBeenCalledWith(
        expect.objectContaining({
          versionStrings: expect.objectContaining({
            CompanyName: '炁体源流',
            LegalCopyright: 'Copyright © 2026 炁体源流'
          })
        })
      )
    } finally {
      edit.mockRestore()
    }
  })
})

describe('Windows x64 native module configuration', () => {
  it('admits exactly one platform and architecture', () => {
    expect(Object.keys(NATIVE_TARGETS)).toEqual(['win32'])
    expect(Object.keys(NATIVE_TARGETS.win32)).toEqual(['x64'])
    expect(resolveNativeTarget({ electronPlatformName: 'win32', arch: 'x64' }).required).toEqual([
      'better-sqlite3/prebuilds/win32-x64.node',
      'koffi/build/koffi/win32_x64/koffi.node'
    ])
  })

  it('uses the real native dependency matcher to exclude known and unknown non-target binaries', async () => {
    const { getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher')
    const config = require('js-yaml').load(
      readFileSync(new URL('../electron-builder.base.yml', import.meta.url), 'utf8')
    )
    config.files = [{ filter: config.files }]
    await configurePackagedNative({
      arch: Arch.x64,
      electronPlatformName: 'win32',
      packager: { config }
    })
    const root = process.cwd()
    const matcher = getNodeModuleFileMatcher(
      root,
      path.join(root, 'dist-test'),
      (value) => value,
      {},
      {
        config,
        debugLogger: { isEnabled: false }
      }
    )
    const filter = matcher.createFilter()
    for (const file of [
      'better-sqlite3/prebuilds/win32-x64.node',
      'koffi/build/koffi/win32_x64/koffi.node'
    ])
      expect(
        filter(path.join(root, 'node_modules', file), { isDirectory: () => false }),
        file
      ).toBe(true)
    for (const file of [
      'better-sqlite3/prebuilds/darwin-x64.node',
      'better-sqlite3/prebuilds/linuxmusl-x64.node',
      'better-sqlite3/prebuilds/win32-arm64.node',
      'better-sqlite3/prebuilds/future-x64.node',
      'better-sqlite3/prebuilds/future/koffi.node',
      'koffi/build/koffi/darwin_x64/koffi.node',
      'koffi/build/koffi/win32_arm64/koffi.node',
      'koffi/build/koffi/musl_x64/koffi.node',
      'koffi/build/koffi/future_x64/koffi.node',
      'koffi/build/koffi/win32_x64/extra.node',
      'koffi/build/koffi/win32_x64/nested/koffi.node',
      'koffi/build/koffi/win32_x64/koffi.exp',
      'koffi/build/koffi/win32_x64/koffi.lib'
    ])
      expect(
        filter(path.join(root, 'node_modules', file), { isDirectory: () => false }),
        file
      ).toBe(false)
    for (const directory of ['better-sqlite3/prebuilds', 'koffi/build/koffi/win32_x64'])
      expect(
        filter(path.join(root, 'node_modules', directory), { isDirectory: () => true }),
        directory
      ).toBe(true)
    expect(
      filter(path.join(root, 'resources/windows-helper.dll'), { isDirectory: () => false })
    ).toBe(true)
  })
  it('excludes local temporary and tool files using the actual builder filters', () => {
    const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher')
    const config = require('js-yaml').load(
      readFileSync(new URL('../electron-builder.base.yml', import.meta.url), 'utf8')
    )
    const root = process.cwd()
    const matcher = getMainFileMatchers(
      root,
      path.join(root, 'dist-test'),
      (value) => value,
      {},
      {
        info: {
          projectDir: root,
          buildResourcesDir: 'build',
          config,
          debugLogger: { isEnabled: false }
        }
      },
      path.join(root, 'dist'),
      false
    )[0]
    const filter = matcher.createFilter()
    for (const file of [
      'tmp/qa/image.png',
      'tmp/server/.env',
      'tools/deploy.py',
      'native_capture/build/bin/capture_ui_tests.exe'
    ]) {
      expect(filter(path.join(root, file), { isDirectory: () => false })).toBe(false)
    }
    expect(filter(path.join(root, 'out/main/index.js'), { isDirectory: () => false })).toBe(true)
  })

  it.each(['tmp', 'tools', 'native_capture'])(
    'rejects %s files if they leak into ASAR',
    async (leakDirectory) => {
      const context = await createPackagedFixture('win32', 'x64', { leakDirectory })
      await expect(
        validatePackagedApp(context, { validateWindowsNativeAbi: vi.fn() })
      ).rejects.toThrow(`Development file leaked into app.asar: /${leakDirectory}`)
    }
  )
  it('rejects a Windows package missing the native capture platform plugin', async () => {
    const context = await createPackagedFixture('win32', 'x64')
    await rm(path.join(context.packager.getResourcesDir(), 'native_capture/platforms/qwindows.dll'))
    await expect(
      validatePackagedApp(context, { validateWindowsNativeAbi: vi.fn() })
    ).rejects.toThrow()
  })
  for (const [platform, platformPlans] of Object.entries(NATIVE_TARGETS)) {
    for (const [arch, plan] of Object.entries(platformPlans)) {
      it(`adds ${platform}-${arch} exclusions before ASAR packaging`, async () => {
        const context = {
          arch: Arch[arch],
          electronPlatformName: platform,
          packager: { config: { files: [{ filter: ['**/*'] }] } }
        }

        await configurePackagedNative(context)
        const patterns = collectFilePatterns(context.packager.config.files)

        expect(patterns).toEqual(expect.arrayContaining(plan.excludePatterns))
        expect(context.packager.config.files).toHaveLength(1)
        expect(context.packager.config.files.every((entry) => typeof entry === 'object')).toBe(true)
      })

      it(`validates a complete ${platform}-${arch} package`, async () => {
        const context = await createPackagedFixture(platform, arch)
        const validateWindowsNativeAbi = vi.fn()
        await expect(
          validatePackagedApp(context, { validateWindowsNativeAbi })
        ).resolves.toBeUndefined()
        expect(validateWindowsNativeAbi).toHaveBeenCalledWith(
          path.join(context.packager.getResourcesDir(), 'native_blur', 'blur_engine.dll'),
          NATIVE_ABI_VERSION
        )
      })
    }
  }

  it.each([
    ['linux', Arch.x64, 'x64'],
    ['darwin', Arch.x64, 'x64'],
    ['darwin', Arch.arm64, 'arm64'],
    ['win32', Arch.arm64, 'arm64'],
    ['win32', Arch.ia32, 'ia32'],
    ['__proto__', '__proto__', '__proto__']
  ])(
    'rejects unsupported %s-%s package targets before changing files',
    async (platform, arch, label) => {
      const config = { files: [{ filter: ['**/*'] }] }
      await expect(
        configurePackagedNative({
          electronPlatformName: platform,
          arch,
          packager: { config }
        })
      ).rejects.toThrow(`Unsupported native package target: ${platform}-${label}`)
      expect(config.files).toEqual([{ filter: ['**/*'] }])
      await expect(validatePackagedApp({ electronPlatformName: platform, arch })).rejects.toThrow(
        `Unsupported native package target: ${platform}-${label}`
      )
    }
  )

  it('preserves the default FileSet and does not duplicate filters on repeated configuration', async () => {
    const fileSet = { filter: ['**/*'] }
    const context = {
      electronPlatformName: 'win32',
      arch: Arch.x64,
      packager: { config: { files: [fileSet] } }
    }
    await configurePackagedNative(context)
    const first = [...fileSet.filter]
    await configurePackagedNative(context)
    expect(context.packager.config.files).toEqual([fileSet])
    expect(context.packager.config.files[0]).toBe(fileSet)
    expect(fileSet.filter).toEqual(first)
    await expect(
      configurePackagedNative({ ...context, packager: { config: { files: ['**/*'] } } })
    ).rejects.toThrow('Default application file set is missing')
  })

  it.each([
    'better-sqlite3/prebuilds/future-x64.node',
    'better-sqlite3/prebuilds/linuxmusl-x64.node',
    'koffi/build/koffi/future_x64/koffi.node',
    'koffi/build/koffi/win32_arm64/koffi.node',
    'koffi/build/koffi/win32_x64/extra.node'
  ])('rejects an unindexed unpacked native binary: %s', async (file) => {
    const context = await createPackagedFixture('win32', 'x64')
    await writeFixture(
      context.packager.getResourcesDir(),
      path.join('app.asar.unpacked/node_modules', file)
    )
    await expect(
      validatePackagedApp(context, { validateWindowsNativeAbi: vi.fn() })
    ).rejects.toThrow(`Unexpected native module in win32-x64 package: ${file}`)
  })

  it.each([
    'better-sqlite3/prebuilds/future-x64.node',
    'koffi/build/koffi/future_x64/koffi.node',
    'koffi/build/koffi/darwin_x64/libforeign.dylib',
    'koffi/build/koffi/linux_x64/libforeign.so.1'
  ])('rejects a native binary packed directly into ASAR: %s', async (file) => {
    const context = await createPackagedFixture('win32', 'x64', {
      nativeFiles: [file],
      unpackNative: false
    })
    await expect(
      validatePackagedApp(context, { validateWindowsNativeAbi: vi.fn() })
    ).rejects.toThrow(`Unexpected native module in win32-x64 package: ${file}`)
  })

  it('keeps the native validator bounded to reviewed binary directories', async () => {
    const context = await createPackagedFixture('win32', 'x64', {
      nativeFiles: ['better-sqlite3/build/Release/better_sqlite3.node']
    })
    await writeFixture(context.packager.getResourcesDir(), 'native_capture/imageformats/qicns.dll')
    await expect(
      validatePackagedApp(context, { validateWindowsNativeAbi: vi.fn() })
    ).resolves.toBeUndefined()
  })

  it('rejects a missing required target module and a blur ABI failure', async () => {
    const missing = await createPackagedFixture('win32', 'x64')
    await rm(
      path.join(
        missing.packager.getResourcesDir(),
        'app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node'
      )
    )
    await expect(
      validatePackagedApp(missing, { validateWindowsNativeAbi: vi.fn() })
    ).rejects.toThrow()
    const mismatch = await createPackagedFixture('win32', 'x64')
    await expect(
      validatePackagedApp(mismatch, {
        validateWindowsNativeAbi: () => {
          throw new Error('controlled blur ABI mismatch')
        }
      })
    ).rejects.toThrow('controlled blur ABI mismatch')
  })

  it('rejects an ASAR header that points to a missing unpacked file', async () => {
    const context = await createPackagedFixture('win32', 'x64', { breakAsar: true })
    await expect(
      validatePackagedApp(context, { validateWindowsNativeAbi: vi.fn() })
    ).rejects.toThrow('Unable to extract some files')

    await access(
      path.join(
        context.packager.getResourcesDir(),
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3',
        'prebuilds',
        'win32-x64.node'
      )
    )
  })

  it('rejects development source leaked into app.asar', async () => {
    const context = await createPackagedFixture('win32', 'x64', { leakSource: true })
    await expect(
      validatePackagedApp(context, { validateWindowsNativeAbi: vi.fn() })
    ).rejects.toThrow('Development file leaked into app.asar: /src')
  })

  it('rejects generated output leaked into app.asar', async () => {
    const context = await createPackagedFixture('win32', 'x64', { leakOutput: true })
    await expect(
      validatePackagedApp(context, { validateWindowsNativeAbi: vi.fn() })
    ).rejects.toThrow('Development file leaked into app.asar: /output')
  })
})
