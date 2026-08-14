const { access, mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { extractAll, listPackage } = require('@electron/asar')
const { resolveNativeTarget } = require('./package-native-plan.cjs')

async function exists(target) {
  try {
    await access(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function validatePackagedApp(context) {
  const target = resolveNativeTarget(context)
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
  const modulesDir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules')

  for (const relativePath of target.required) {
    await access(path.join(modulesDir, relativePath))
  }

  for (const relativePath of target.forbidden) {
    if (await exists(path.join(modulesDir, relativePath))) {
      throw new Error(
        `Unexpected native module in ${target.platform}-${target.arch} package: ${relativePath}`
      )
    }
  }

  const windowsBlurPath = path.join(resourcesDir, 'native_blur', 'blur_engine.dll')
  if (target.requiresWindowsBlur) {
    await access(windowsBlurPath)
  } else if (await exists(windowsBlurPath)) {
    throw new Error(
      `Windows blur DLL must not be included in ${target.platform}-${target.arch} package`
    )
  }

  const asarPath = path.join(resourcesDir, 'app.asar')
  const forbiddenAsarPrefixes = [
    '/.audit-unpacked/',
    '/.git/',
    '/build/',
    '/docs/',
    '/native_blur/',
    '/scripts/',
    '/src/',
    '/tests/'
  ]
  const forbiddenAsarFiles = new Set(['/AGENTS.md'])
  const leakedEntry = listPackage(asarPath)
    .map((entry) => entry.replaceAll('\\', '/'))
    .find(
      (entry) =>
        forbiddenAsarFiles.has(entry) ||
        entry.startsWith('/electron-builder.') ||
        forbiddenAsarPrefixes.some((prefix) => entry.startsWith(prefix))
    )

  if (leakedEntry) {
    throw new Error(`Development file leaked into app.asar: ${leakedEntry}`)
  }

  const extractionRoot = await mkdtemp(path.join(tmpdir(), 'abandon-asar-verify-'))
  try {
    extractAll(asarPath, extractionRoot)
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }

  console.log(`[package-verify] ${target.platform}-${target.arch} native modules and ASAR verified`)
}

exports.default = validatePackagedApp
exports.exists = exists
