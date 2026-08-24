const { access, mkdtemp, rm } = require('node:fs/promises')
const { execFileSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { extractAll, listPackage } = require('@electron/asar')
const { resolveNativeTarget } = require('./package-native-plan.cjs')

const projectRoot = path.resolve(__dirname, '..')

async function getExpectedNativeAbiVersion() {
  const moduleUrl = pathToFileURL(
    path.join(projectRoot, 'src', 'shared', 'native-abi-version.js')
  ).href
  const { NATIVE_ABI_VERSION } = await import(moduleUrl)
  return NATIVE_ABI_VERSION
}

function validateWindowsNativeAbi(dllPath, expectedAbiVersion) {
  const checkScript = [
    "const koffi = require('koffi')",
    'const library = koffi.load(process.argv[1])',
    "const getAbiVersion = library.func('AbandonNative_GetAbiVersion', 'int', [])",
    'process.stdout.write(String(getAbiVersion()))'
  ].join(';')
  const output = execFileSync(process.execPath, ['-e', checkScript, dllPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true
  })
  const actualAbiVersion = Number(output.trim())
  if (!Number.isInteger(actualAbiVersion) || actualAbiVersion !== expectedAbiVersion) {
    throw new Error(
      `Windows blur DLL ABI mismatch: expected=${expectedAbiVersion}, actual=${output.trim() || 'invalid'}`
    )
  }
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function validatePackagedApp(context, dependencies = {}) {
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
    const expectedAbiVersion = await getExpectedNativeAbiVersion()
    const validateAbi = dependencies.validateWindowsNativeAbi || validateWindowsNativeAbi
    validateAbi(windowsBlurPath, expectedAbiVersion)
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
exports.getExpectedNativeAbiVersion = getExpectedNativeAbiVersion
exports.validateWindowsNativeAbi = validateWindowsNativeAbi
