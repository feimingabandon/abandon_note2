const { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')

const QT_NAMES = Object.freeze([
  'capture_core',
  'capture_ui',
  'capture_ux',
  'capture_selection',
  'capture_pin_halo',
  'capture_polish',
  'capture_clipboard'
])

function environmentValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

function environmentDigest(env) {
  const values = Object.keys(env)
    .sort()
    .map((name) => [name, String(env[name])])
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

function localSource(root, name, { optional = false } = {}) {
  const target = resolve(root, name)
  const part = relative(root, target)
  if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part))
    throw new Error('Build source path escapes the repository: ' + name)
  let current = root
  for (const component of part.split(sep)) {
    current = join(current, component)
    if (!existsSync(current)) {
      if (optional) return null
      throw new Error('Build descriptor input is missing: ' + name)
    }
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
      throw new Error('Build descriptor cannot read links/junctions/hard links: ' + name)
    const actual = realpathSync(current)
    if (
      process.platform === 'win32'
        ? actual.toLowerCase() !== current.toLowerCase()
        : actual !== current
    )
      throw new Error('Build descriptor input has an indirect location: ' + name)
  }
  return target
}

function rootEnvironmentFiles(root) {
  return readdirSync(root)
    .filter((name) => name === '.env' || name.startsWith('.env.'))
    .sort()
    .map((name) => {
      const location = localSource(root, name)
      if (!lstatSync(location).isFile())
        throw new Error('Vite environment input must be a file: ' + name)
      return name
    })
}

function abiDeclaration(root) {
  const filename = localSource(root, 'src/shared/native-abi-version.js')
  const match = /^export const NATIVE_ABI_VERSION = (\d+)\s*$/m.exec(readFileSync(filename, 'utf8'))
  if (!match) throw new Error('Native ABI declaration was not found')
  return { declared: Number(match[1]), validation: 'declaration-only' }
}

function toolFile(name, location) {
  return location && existsSync(location) && lstatSync(location).isFile()
    ? { name, path: resolve(location) }
    : null
}

function findOnPath(name, env) {
  const separator = process.platform === 'win32' ? ';' : ':'
  for (const directory of (environmentValue(env, 'PATH') || '').split(separator)) {
    if (!directory || /volta/i.test(directory)) continue
    const candidate = join(directory, name)
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate
  }
  return null
}

function cacheValue(root, filename, key) {
  const target = localSource(root, filename, { optional: true })
  if (!target) return null
  const line = readFileSync(target, 'utf8')
    .split(/\r?\n/)
    .find((value) => value.startsWith(key + ':'))
  if (!line) return null
  const result = line.slice(line.indexOf('=') + 1)
  return result && isAbsolute(result) ? result : null
}

function visualStudioTools(env) {
  const programFiles = environmentValue(env, 'ProgramFiles(x86)')
  if (!programFiles) return {}
  const vswhere = join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe')
  if (!existsSync(vswhere)) return {}
  const found = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath'
    ],
    { encoding: 'utf8', env, windowsHide: true, timeout: 10_000 }
  )
  if (found.status !== 0 || found.error) throw new Error('Visual Studio tool discovery failed')
  const directory = found.stdout.trim()
  if (!directory || /[\r\n]/.test(directory))
    throw new Error('Visual Studio tool discovery returned no unique installation')
  return {
    vswhere,
    cmake: join(directory, 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe')
  }
}

function nativeSourceFiles(root, directory) {
  const target = localSource(root, directory)
  return readdirSync(target)
    .sort()
    .filter((name) => !['build', 'build-transition', 'deploy'].includes(name))
    .map((name) => {
      localSource(root, directory + '/' + name)
      return directory + '/' + name
    })
}

function checkedQtNames(values) {
  if (!Array.isArray(values)) throw new Error('Qt test names must be an explicit array')
  if (new Set(values).size !== values.length)
    throw new Error('Duplicate Qt test names are not allowed')
  for (const value of values)
    if (!QT_NAMES.includes(value)) throw new Error('Unknown Qt test name: ' + value)
  return [...values].sort()
}

function nodeDescriptor({ root, id, nodeExecutable, env }) {
  const app = id === 'build-app'
  const inputs = [
    'src',
    'resources',
    'package.json',
    'package-lock.json',
    'node_modules',
    ...rootEnvironmentFiles(root),
    ...(app
      ? ['electron.vite.config.mjs']
      : ['tools/notice-preview', 'scripts/build-notice-preview.mjs'])
  ]
  const outputs = app
    ? [
        'out/main',
        'out/preload',
        'out/renderer',
        'out/main/index.js',
        'out/preload/index.js',
        'out/renderer/index.html'
      ]
    : [
        'tmp/notice-preview-dist',
        'tmp/notice-preview-dist/index.html',
        'tmp/notice-preview-dist/source-manifest.json'
      ]
  const toolchain = {
    files: [{ name: 'node', path: resolve(nodeExecutable) }],
    metadata: { dependencyScope: 'complete-workspace-node_modules-tree' }
  }
  const esbuildOverride = environmentValue(env, 'ESBUILD_BINARY_PATH')
  if (esbuildOverride)
    toolchain.files.push({ name: 'esbuild-override', path: resolve(root, esbuildOverride) })
  const injected = ['NODE_OPTIONS', 'NODE_PATH'].filter((name) => environmentValue(env, name))
  const snapshotOptions = {
    root,
    id,
    mode: {
      target: app ? 'electron-app' : 'notice-preview',
      configuration: 'production',
      environmentDigest: environmentDigest(env)
    },
    inputs,
    outputs,
    toolchain,
    closure: {
      complete: injected.length === 0,
      basis: injected.length
        ? 'External Node injection remains unreviewed: ' + injected.join(', ')
        : 'Reviewed fixed build configuration; all client sources/resources, package/config/env files, installed module tree and exact Node/esbuild executable are captured'
    },
    abi: app ? abiDeclaration(root) : {}
  }
  return {
    snapshotOptions,
    command: resolve(nodeExecutable),
    args: app
      ? ['node_modules/electron-vite/bin/electron-vite.js', 'build']
      : ['scripts/build-notice-preview.mjs'],
    outputs
  }
}

function nativeDescriptor({ root, id, qtNames, env, inputDriver }) {
  const capture = id === 'build-capture'
  if (!capture && qtNames.length) throw new Error('Qt names only apply to build-capture')
  const selected = checkedQtNames(qtNames)
  const testsOnly = selected.length > 0 && !inputDriver
  const namesHash = createHash('sha256')
    .update(JSON.stringify({ selected, inputDriver }))
    .digest('hex')
    .slice(0, 12)
  const buildDirectory = capture
    ? join(
        root,
        testsOnly || inputDriver
          ? 'tmp/focused-builds/capture-' + namesHash
          : 'native_capture/build'
      )
    : join(root, 'native_blur/build')
  const cacheName = relative(root, join(buildDirectory, 'CMakeCache.txt')).replaceAll('\\', '/')
  const fallbackCache = capture
    ? 'native_capture/build/CMakeCache.txt'
    : 'native_blur/build/CMakeCache.txt'
  const cachedCmake =
    cacheValue(root, cacheName, 'CMAKE_COMMAND') || cacheValue(root, fallbackCache, 'CMAKE_COMMAND')
  const visualStudio = visualStudioTools(env)
  // Match the two build scripts before the first CMake cache exists. Capture
  // always selects VS's CMake; blur first uses PATH and then the VS fallback.
  const cmake = capture
    ? visualStudio.cmake || cachedCmake || findOnPath('cmake.exe', env)
    : findOnPath('cmake.exe', env) || visualStudio.cmake || cachedCmake
  const ctest = cmake
    ? join(dirname(cmake), process.platform === 'win32' ? 'ctest.exe' : 'ctest')
    : null
  const windowsRoot = environmentValue(env, 'SystemRoot') || 'C:/Windows'
  const powershell = join(windowsRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const qtRoot = resolve(
    root,
    environmentValue(env, 'QT_ROOT_DIR') || 'tmp/toolchains/qt/6.8.3/msvc2022_64'
  )
  const files = [
    toolFile('powershell', powershell),
    toolFile('vswhere', visualStudio.vswhere),
    toolFile('cmake', cmake),
    toolFile('ctest', ctest)
  ]
  for (const key of ['CMAKE_CXX_COMPILER', 'CMAKE_RC_COMPILER', 'CMAKE_MAKE_PROGRAM']) {
    const compiler = cacheValue(root, cacheName, key) || cacheValue(root, fallbackCache, key)
    files.push(toolFile(key.toLowerCase(), compiler))
  }
  if (capture) {
    files.push(toolFile('qt-qmake', join(qtRoot, 'bin/qmake.exe')))
    files.push(toolFile('qt-deploy', join(qtRoot, 'bin/windeployqt.exe')))
  }
  const relativeBuild = relative(root, buildDirectory).replaceAll('\\', '/')
  const outputs = capture
    ? testsOnly
      ? [relativeBuild + '/bin']
      : [
          'native_capture/deploy',
          'native_capture/deploy/AbandonCapture.exe',
          'native_capture/deploy/capture_host.dll'
        ]
    : ['native_blur/build/bin', 'native_blur/build/bin/blur_engine.dll']
  if (capture)
    outputs.push(...selected.map((name) => relativeBuild + '/bin/' + name + '_tests.exe'))
  if (inputDriver) outputs.push(relativeBuild + '/bin/capture_input_driver.exe')
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    capture ? 'native_capture/build.ps1' : 'native_blur/build.ps1'
  ]
  if (capture) {
    args.push('-QtRoot', qtRoot, '-BuildDirectory', buildDirectory, '-BuildOnly')
    if (selected.length) {
      args.push('-Test')
      if (testsOnly) args.push('-TestsOnly')
      args.push('-TestName', selected.join(','))
    }
    if (inputDriver) args.push('-InputDriver')
  } else args.push('-Architecture', 'x64', '-Configuration', 'Release')
  const snapshotOptions = {
    root,
    id,
    mode: {
      target: capture ? 'capture' : 'blur',
      configuration: 'Release',
      architecture: 'x64',
      product: !testsOnly,
      inputDriver,
      qtNames: selected,
      qtRoot: capture ? qtRoot : null,
      buildDirectory: relativeBuild,
      environmentDigest: environmentDigest(env)
    },
    inputs: [
      ...nativeSourceFiles(root, capture ? 'native_capture' : 'native_blur'),
      'src/shared/native-abi-version.js',
      ...(capture ? ['LICENSE'] : [])
    ],
    outputs,
    toolchain: {
      files: files.filter(Boolean),
      metadata: {
        discovery: 'read-only-existing-CMake-cache-and-explicit-environment',
        closure: 'unreviewed'
      }
    },
    closure: {
      complete: false,
      basis:
        'Read-only discovery cannot certify VS latest selection, compiler/SDK headers/libraries, Qt full tree and transitive tool dependencies; only rebuild is permitted'
    },
    abi: capture ? { validation: 'native-capture-protocol-not-probed' } : abiDeclaration(root)
  }
  return {
    snapshotOptions,
    command: powershell,
    args,
    outputs,
    buildDirectory,
    ...(inputDriver
      ? { inputDriverPath: join(buildDirectory, 'bin/capture_input_driver.exe') }
      : {}),
    ctest,
    ...(capture ? { qtRoot } : { requireValidation: 'native-runtime-probe' })
  }
}

function describeBuild({
  root,
  id,
  nodeExecutable = process.execPath,
  qtNames = [],
  env = process.env,
  inputDriver = false
}) {
  const directory = resolve(root)
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
    throw new Error('Build root must be a direct repository directory')
  const actual = realpathSync(directory)
  if (
    process.platform === 'win32'
      ? actual.toLowerCase() !== directory.toLowerCase()
      : actual !== directory
  )
    throw new Error('Build root cannot traverse a symbolic link/junction')
  if (!['build-app', 'build-notice-preview', 'build-native', 'build-capture'].includes(id))
    throw new Error('Unknown build descriptor id: ' + id)
  if (id === 'build-app' || id === 'build-notice-preview') {
    if (qtNames.length || inputDriver)
      throw new Error('Qt/driver targets require a native capture build')
    return nodeDescriptor({ root: directory, id, nodeExecutable, env })
  }
  return nativeDescriptor({ root: directory, id, qtNames, env, inputDriver })
}

module.exports = { describeBuild, QT_NAMES }
