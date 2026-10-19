const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const SCHEMA = 'abandon-test-build-proof/v1'

class BuildProvenanceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BuildProvenanceError'
    this.code = code
  }
}

function fail(code, message) {
  throw new BuildProvenanceError(code, message)
}

function text(value, label) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    fail('INVALID_DESCRIPTOR', `${label} must be a non-empty string without control characters`)
  return value.trim()
}

function stable(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      fail('INVALID_DESCRIPTOR', 'Metadata must contain plain JSON objects')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stable(value[key]))
        .join(',') +
      '}'
    )
  }
  fail('INVALID_DESCRIPTOR', 'Metadata must contain only JSON values')
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function copy(value) {
  return JSON.parse(stable(value))
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function inside(root, target) {
  const part = path.relative(root, target)
  return part && part !== '..' && !part.startsWith('..' + path.sep) && !path.isAbsolute(part)
}

function relativePath(value, label) {
  const result = text(value, label).replaceAll('\\', '/')
  if (
    path.isAbsolute(result) ||
    /^[a-z]:/i.test(result) ||
    result.startsWith('/') ||
    /[:*?[\]]/.test(result) ||
    result.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail('UNSAFE_PATH', `${label} must be a literal repository-relative path: ${result}`)
  return result
}

function lstat(target) {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// Walk every prefix before touching content. realpath alone would follow a junction first.
function checkPath(target, { allowMissing = false, fileOnly = false, allowHardLink = false } = {}) {
  const absolute = path.resolve(target)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stat = lstat(current)
    if (!stat) {
      if (allowMissing) return null
      fail('MISSING_PATH', 'Required provenance path is missing: ' + current)
    }
    if (stat.isSymbolicLink()) fail('LINK_PATH', 'Links/junctions are not accepted: ' + current)
    if (!stat.isFile() && !stat.isDirectory())
      fail('UNSAFE_PATH', 'Only regular files and directories are accepted: ' + current)
    if (stat.isFile() && stat.nlink !== 1 && !allowHardLink)
      fail('HARD_LINK', 'Hard-linked files are not accepted: ' + current)
    if (!samePath(fs.realpathSync(current), current))
      fail('LINK_PATH', 'Path does not have a direct real location: ' + current)
    if (!samePath(current, absolute) && !stat.isDirectory())
      fail('UNSAFE_PATH', 'Path ancestor must be a directory: ' + current)
  }
  const stat = fs.lstatSync(absolute)
  if (fileOnly && !stat.isFile())
    fail('INVALID_DESCRIPTOR', 'An explicit tool/evidence path must be one file: ' + absolute)
  return stat
}

function rootPath(root) {
  const result = path.resolve(text(root, 'root'))
  if (!checkPath(result).isDirectory()) fail('UNSAFE_PATH', 'Repository root must be a directory')
  return result
}

function safeTarget(root, relative) {
  const target = path.resolve(root, relative)
  if (!inside(root, target)) fail('UNSAFE_PATH', 'Path escapes repository: ' + relative)
  return target
}

function identity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

function fileContents(target, { allowHardLink = false } = {}) {
  const before = checkPath(target, { fileOnly: true, allowHardLink })
  const fd = fs.openSync(target, 'r')
  try {
    const opened = fs.fstatSync(fd)
    if ((!allowHardLink && opened.nlink !== 1) || identity(before) !== identity(opened))
      fail('PATH_CHANGED', 'Provenance file changed while opening: ' + target)
    const contents = fs.readFileSync(fd)
    const after = checkPath(target, { fileOnly: true, allowHardLink })
    if (identity(opened) !== identity(after))
      fail('PATH_CHANGED', 'Provenance file changed while hashing: ' + target)
    return contents
  } finally {
    fs.closeSync(fd)
  }
}

function fileHash(target, options) {
  const contents = fileContents(target, options)
  return { bytes: contents.byteLength, sha256: hash(contents) }
}

function normalizePaths(values, label) {
  if (!Array.isArray(values) || !values.length)
    fail('INVALID_DESCRIPTOR', `${label} must explicitly list at least one file/directory`)
  const result = values.map((value) => relativePath(value, label)).sort()
  const keys = result.map((value) => (process.platform === 'win32' ? value.toLowerCase() : value))
  if (new Set(keys).size !== result.length)
    fail('INVALID_DESCRIPTOR', 'Duplicate provenance path in ' + label)
  return result
}

function manifest(root, paths, { allowMissing = false } = {}) {
  const entries = new Map()
  function visit(relative) {
    const target = safeTarget(root, relative)
    const before = checkPath(target, { allowMissing })
    if (!before) {
      entries.set(relative, { path: relative, kind: 'missing' })
      return
    }
    if (before.isFile()) {
      entries.set(relative, { path: relative, kind: 'file', ...fileHash(target) })
      return
    }
    entries.set(relative, { path: relative, kind: 'directory' })
    const names = fs.readdirSync(target).sort()
    for (const name of names) visit(relative + '/' + name)
    const after = checkPath(target)
    if (
      identity(before) !== identity(after) ||
      stable(names) !== stable(fs.readdirSync(target).sort())
    )
      fail('PATH_CHANGED', 'Provenance directory changed while enumerating: ' + target)
  }
  for (const item of paths) visit(item)
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function normalizeToolchain(root, toolchain) {
  if (!toolchain || !Array.isArray(toolchain.files) || !toolchain.files.length)
    fail('INVALID_DESCRIPTOR', 'Toolchain must explicitly name its actual tool files')
  const files = toolchain.files.map((entry) => {
    const name = text(entry.name, 'Tool name')
    const location = text(entry.path, 'Tool path')
    if (
      /[*?[\]]/.test(location) ||
      location.startsWith('\\\\') ||
      location.startsWith('//') ||
      location.includes('://') ||
      location.replace(/^[a-z]:[\\/]/i, '').includes(':')
    )
      fail('UNSAFE_PATH', 'Tool path must be an explicit local file')
    const target = path.isAbsolute(location)
      ? path.resolve(location)
      : safeTarget(root, relativePath(location, 'Tool path'))
    // Explicit external tools are read-only. Windows system files legitimately
    // share WinSxS hard links; source/output/proof destinations stay strict.
    const allowHardLink = !inside(root, target)
    checkPath(target, { fileOnly: true, allowHardLink })
    return { name, path: target, ...fileHash(target, { allowHardLink }) }
  })
  files.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  if (new Set(files.map((entry) => entry.name)).size !== files.length)
    fail('INVALID_DESCRIPTOR', 'Tool names must be unique')
  return { files, metadata: copy(toolchain.metadata || {}) }
}

function closureValue(closure) {
  return {
    complete:
      closure?.complete === true && typeof closure?.basis === 'string' && !!closure.basis.trim(),
    basis: typeof closure?.basis === 'string' ? closure.basis.trim() : ''
  }
}

function createBuildSnapshot({ root, id, mode, inputs, outputs, toolchain, closure, abi = {} }) {
  const directory = rootPath(root)
  const buildId = text(id, 'Build id')
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(buildId))
    fail('INVALID_DESCRIPTOR', 'Build id must be a safe single directory name')
  const inputPaths = normalizePaths(inputs, 'inputs')
  const outputPaths = normalizePaths(outputs, 'outputs')
  for (const input of inputPaths)
    for (const output of outputPaths)
      if (
        samePath(input, output) ||
        (process.platform === 'win32' ? input.toLowerCase() : input).startsWith(
          (process.platform === 'win32' ? output.toLowerCase() : output) + '/'
        ) ||
        (process.platform === 'win32' ? output.toLowerCase() : output).startsWith(
          (process.platform === 'win32' ? input.toLowerCase() : input) + '/'
        )
      )
        fail('INVALID_DESCRIPTOR', 'Input/output roots must not overlap')
  const snapshot = {
    schema: SCHEMA,
    root: directory,
    id: buildId,
    mode: copy(mode),
    platform: process.platform,
    arch: process.arch,
    closure: closureValue(closure),
    descriptors: { inputs: inputPaths, outputs: outputPaths },
    inputs: manifest(directory, inputPaths),
    outputs: manifest(directory, outputPaths, { allowMissing: true }),
    toolchain: normalizeToolchain(directory, toolchain),
    abi: copy(abi)
  }
  return freeze({ ...snapshot, fingerprint: hash(stable(snapshot)) })
}

function inputState(snapshot) {
  const state = { ...snapshot }
  delete state.outputs
  delete state.fingerprint
  return state
}

function snapshotOptions(before) {
  return {
    root: before.root,
    id: before.id,
    mode: before.mode,
    inputs: before.descriptors.inputs,
    outputs: before.descriptors.outputs,
    toolchain: before.toolchain,
    closure: before.closure,
    abi: before.abi
  }
}

function validationEvidence(root, value) {
  if (!value || value.status === 'not-performed') return { status: 'not-performed' }
  if (value.status !== 'passed' || !Array.isArray(value.evidence) || !value.evidence.length)
    fail('INVALID_VALIDATION', 'Passed validation needs explicit evidence files')
  const evidence = value.evidence.map((entry) => {
    const relative = relativePath(entry.path, 'Validation evidence')
    const actual = fileHash(safeTarget(root, relative))
    if (typeof entry.sha256 !== 'string' || entry.sha256 !== actual.sha256)
      fail(
        'INVALID_VALIDATION',
        'Validation evidence does not match its recorded hash: ' + relative
      )
    return { path: relative, ...actual }
  })
  return { status: 'passed', kind: text(value.kind, 'Validation kind'), evidence }
}

function ensureDirectory(root, relative) {
  const target = safeTarget(root, relative)
  checkPath(target, { allowMissing: true })
  fs.mkdirSync(target, { recursive: true })
  checkPath(target)
  return target
}

function proofDirectoryPath(root, proofDirectory, id) {
  const relative = relativePath(proofDirectory, 'proofDirectory')
  const target = safeTarget(root, relative + '/' + id)
  checkPath(target, { allowMissing: true })
  return { relative, target }
}

function newProofDirectory(root, relative) {
  const parent = ensureDirectory(root, relative)
  let sequence = Date.now()
  for (const name of fs.readdirSync(parent)) {
    if (!/^\d{16}$/.test(name) || !Number.isSafeInteger(Number(name)))
      fail('INVALID_PROOF', 'Unexpected entry in the proof attempt directory: ' + name)
    sequence = Math.max(sequence, Number(name) + 1)
  }
  // Reserve an ordered immutable attempt atomically, even across concurrent processes or clock rollback.
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const target = path.join(parent, String(sequence).padStart(16, '0'))
    checkPath(parent)
    try {
      fs.mkdirSync(target)
      checkPath(target)
      return target
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      sequence += 1
    }
  }
  fail('PROOF_CONTENTION', 'Could not reserve a new immutable proof attempt')
}

// Invoke only after a successful build. Failed/retried builds never replace previous proofs.
function writeBuildProof({
  root,
  proofDirectory,
  id,
  before,
  inputs = before?.descriptors?.inputs,
  outputs = before?.descriptors?.outputs,
  mode = before?.mode,
  toolchain = before?.toolchain,
  closure = before?.closure,
  abi = before?.abi,
  validation
}) {
  if (!before || before.schema !== SCHEMA)
    fail('INVALID_SNAPSHOT', 'A pre-build snapshot is required')
  const current = createBuildSnapshot({
    ...snapshotOptions(before),
    root,
    id,
    inputs,
    outputs,
    mode,
    toolchain,
    closure,
    abi
  })
  if (!current.closure.complete)
    fail('UNKNOWN_CLOSURE', 'Input/toolchain closure has not been reviewed')
  if (stable(inputState(before)) !== stable(inputState(current)))
    fail('INPUT_DRIFT', 'Build inputs, mode, ABI or toolchain changed during the build')
  if (current.outputs.some((entry) => entry.kind === 'missing'))
    fail('MISSING_OUTPUT', 'Every declared output must exist before a build proof is issued')
  const destination = proofDirectoryPath(current.root, proofDirectory, current.id)
  for (const item of [...current.descriptors.inputs, ...current.descriptors.outputs]) {
    const value = safeTarget(current.root, item)
    if (
      inside(value, destination.target) ||
      inside(destination.target, value) ||
      samePath(value, destination.target)
    )
      fail('INVALID_DESCRIPTOR', 'Proof directory must be outside input/output roots')
  }
  const record = freeze({
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    snapshot: current,
    validation: validationEvidence(current.root, validation)
  })
  const directory = newProofDirectory(current.root, destination.relative + '/' + current.id)
  const proofPath = path.join(directory, 'proof.json')
  fs.writeFileSync(proofPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
  return freeze({ proofPath, record })
}

function verifyBuildProof(options) {
  let snapshot
  try {
    snapshot = createBuildSnapshot(options)
    if (!snapshot.closure.complete)
      return { verified: false, status: 'unverified', reasons: ['UNKNOWN_CLOSURE'], snapshot }
    if (snapshot.outputs.some((entry) => entry.kind === 'missing'))
      return { verified: false, status: 'unverified', reasons: ['MISSING_OUTPUT'], snapshot }
    const { target } = proofDirectoryPath(snapshot.root, options.proofDirectory, snapshot.id)
    const directoryStat = checkPath(target, { allowMissing: true })
    if (!directoryStat)
      return { verified: false, status: 'unverified', reasons: ['MISSING_PROOF'], snapshot }
    if (!directoryStat.isDirectory()) fail('INVALID_PROOF', 'Proof collection must be a directory')
    const names = fs.readdirSync(target).sort().reverse()
    if (!names.length)
      return { verified: false, status: 'unverified', reasons: ['MISSING_PROOF'], snapshot }
    // Only the latest immutable attempt is eligible. Never fall back past a corrupt/latest failure.
    const name = names[0]
    relativePath(name, 'Proof attempt')
    const proofPath = path.join(target, name, 'proof.json')
    checkPath(proofPath, { fileOnly: true })
    const record = JSON.parse(fileContents(proofPath).toString('utf8'))
    if (record.schema !== SCHEMA || record.snapshot?.schema !== SCHEMA)
      fail('INVALID_PROOF', 'Unsupported build proof schema')
    const { fingerprint, ...recordedState } = record.snapshot
    if (fingerprint !== hash(stable(recordedState)))
      fail('INVALID_PROOF', 'Stored proof fingerprint is invalid')
    if (stable(record.snapshot) !== stable(snapshot))
      return {
        verified: false,
        status: 'unverified',
        reasons: ['BUILD_STATE_CHANGED'],
        proofPath,
        snapshot
      }
    const validation = validationEvidence(snapshot.root, record.validation)
    if (
      options.requireValidation &&
      (validation.status !== 'passed' || validation.kind !== options.requireValidation)
    )
      return {
        verified: false,
        status: 'unverified',
        reasons: ['MISSING_VALIDATION'],
        proofPath,
        snapshot
      }
    return {
      verified: true,
      status: 'verified',
      reasons: [],
      proofPath,
      snapshot,
      abiStatus: 'declared-only',
      validationStatus: validation.status,
      validation
    }
  } catch (error) {
    return {
      verified: false,
      status: 'unverified',
      reasons: [error.code || 'INVALID_PROOF'],
      message: error.message,
      ...(snapshot ? { snapshot } : {})
    }
  }
}

module.exports = { BuildProvenanceError, createBuildSnapshot, writeBuildProof, verifyBuildProof }
