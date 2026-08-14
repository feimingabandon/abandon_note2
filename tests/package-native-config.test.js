import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { Arch } from 'builder-util'

const require = createRequire(import.meta.url)
const { createPackageWithOptions } = require('@electron/asar')
const {
  default: configurePackagedNative,
  collectFilePatterns
} = require('../scripts/configure-packaged-native.cjs')
const { NATIVE_TARGETS, resolveNativeTarget } = require('../scripts/package-native-plan.cjs')
const { default: validatePackagedApp } = require('../scripts/validate-packaged-app.cjs')

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
  { breakAsar = false, leakSource = false } = {}
) {
  const root = await mkdtemp(path.join(tmpdir(), 'abandon-package-native-'))
  temporaryRoots.push(root)
  const appSource = path.join(root, 'app-source')
  const resourcesDir = path.join(root, 'resources')
  const target = resolveNativeTarget({ electronPlatformName: platform, arch: Arch[arch] })

  await writeFixture(appSource, 'package.json', '{"name":"package-fixture"}')
  for (const relativePath of target.required) {
    await writeFixture(appSource, path.join('node_modules', relativePath))
  }
  await writeFixture(appSource, path.join('resources', 'icon.png'))
  if (leakSource) {
    await writeFixture(appSource, path.join('src', 'main.js'), 'console.log("leaked")')
  }
  await mkdir(resourcesDir, { recursive: true })
  await createPackageWithOptions(appSource, path.join(resourcesDir, 'app.asar'), {
    unpack: '*.node',
    unpackDir: 'resources'
  })

  if (target.requiresWindowsBlur) {
    await writeFixture(resourcesDir, path.join('native_blur', 'blur_engine.dll'))
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

describe('platform native module configuration', () => {
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
        await expect(validatePackagedApp(context)).resolves.toBeUndefined()
      })
    }
  }

  it('rejects unsupported package targets', async () => {
    await expect(
      configurePackagedNative({
        electronPlatformName: 'linux',
        arch: Arch.x64,
        packager: { config: { files: [] } }
      })
    ).rejects.toThrow('Unsupported native package target: linux-x64')
  })

  it('rejects an ASAR header that points to a missing unpacked file', async () => {
    const context = await createPackagedFixture('win32', 'x64', { breakAsar: true })
    await expect(validatePackagedApp(context)).rejects.toThrow('Unable to extract some files')

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
    await expect(validatePackagedApp(context)).rejects.toThrow(
      'Development file leaked into app.asar: /src'
    )
  })
})
