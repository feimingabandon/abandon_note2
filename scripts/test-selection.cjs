const path = require('node:path')

const LEVELS = new Set([
  'unit',
  'database',
  'storage',
  'gui',
  'native',
  'install',
  'performance',
  'support',
  'build'
])
const ROLES = new Set(['test', 'helper', 'fixture', 'build'])
const RUNTIMES = new Set([
  'vitest',
  'electron-node',
  'electron',
  'powershell',
  'node',
  'qt',
  'none'
])
const POLICIES = new Set(['focused', 'explicit', 'support'])
const LIST_FIELDS = [
  'features',
  'contracts',
  'sourceDependencies',
  'sourceReadDependencies',
  'requires',
  'runtimePrerequisites'
]
const VALUE_FLAGS = new Map([
  ['--file', 'files'],
  ['--id', 'ids'],
  ['--feature', 'features'],
  ['--source', 'sources'],
  ['--build', 'build'],
  ['--level', 'level']
])

class TestSelectionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TestSelectionError'
    this.code = code
  }
}

function fail(code, message) {
  throw new TestSelectionError(code, message)
}

function hasControlCharacters(value) {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32)
}

function textValue(value, label) {
  if (typeof value !== 'string' || !value.trim() || hasControlCharacters(value)) {
    fail('INVALID_VALUE', `${label} must be a non-empty string without control characters`)
  }
  return value.trim()
}

function parseSelectionArgs(argv) {
  if (!Array.isArray(argv)) fail('INVALID_ARGUMENTS', 'Arguments must be an array')
  const selection = {
    files: [],
    ids: [],
    features: [],
    sources: [],
    plan: false,
    build: 'rebuild',
    level: null
  }
  const singletonFlags = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = textValue(argv[index], 'Argument')
    if (argument === '--all')
      fail('FULL_SELECTION_FORBIDDEN', 'The focused selector does not accept --all')
    if (argument === '--plan') {
      selection.plan = true
      continue
    }
    const separator = argument.indexOf('=')
    const flag = separator === -1 ? argument : argument.slice(0, separator)
    const field = VALUE_FLAGS.get(flag)
    if (!field) fail('UNKNOWN_ARGUMENT', `Unknown argument: ${argument}`)
    let value = separator === -1 ? argv[index + 1] : argument.slice(separator + 1)
    if (separator === -1) index += 1
    value = textValue(value, `Value for ${flag}`)
    if (value.startsWith('--'))
      fail('MISSING_VALUE', `${flag} requires a value before the next flag`)
    if (Array.isArray(selection[field])) {
      selection[field].push(value)
    } else {
      if (singletonFlags.has(flag)) fail('DUPLICATE_ARGUMENT', `${flag} may only be specified once`)
      singletonFlags.add(flag)
      selection[field] = value
    }
  }
  validateSelection(selection)
  return selection
}

function validateSelection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('INVALID_SELECTION', 'Selection must be an object')
  const selection = {
    files: [],
    ids: [],
    features: [],
    sources: [],
    plan: false,
    build: 'rebuild',
    level: null,
    ...input
  }
  for (const field of ['files', 'ids', 'features', 'sources']) {
    if (!Array.isArray(selection[field])) fail('INVALID_SELECTION', `${field} must be an array`)
    selection[field] = selection[field].map((value) => textValue(value, field))
  }
  if (typeof selection.plan !== 'boolean') fail('INVALID_SELECTION', 'plan must be a boolean')
  if (!['rebuild', 'reuse-verified'].includes(selection.build))
    fail('INVALID_BUILD_MODE', 'build must be rebuild or reuse-verified')
  if (selection.level !== null && !LEVELS.has(selection.level))
    fail('INVALID_LEVEL', `Unknown level: ${selection.level}`)
  if (['build', 'support'].includes(selection.level))
    fail('INVALID_LEVEL', 'A focused test level cannot select build or support entries')
  return selection
}

function pathContext(root) {
  if (root === undefined) return { root: null, windows: false, api: path.posix }
  const value = textValue(root, 'Repository root')
  if (/^[\\/]{2}/.test(value) || hasControlCharacters(value) || /[*?{}[\]]/.test(value))
    fail('INVALID_ROOT', 'Repository root must be an absolute local path')
  const windows = /^[A-Za-z]:[\\/]/.test(value)
  const api = windows ? path.win32 : path.posix
  if (!api.isAbsolute(value)) fail('INVALID_ROOT', 'Repository root must be an absolute local path')
  return { root: api.normalize(value.replace(/\\/g, '/')), windows, api }
}

function normalizeFile(value, context, label) {
  const input = textValue(value, label)
  if (
    /^[\\/]{2}/.test(input) ||
    /[*?{}[\]]/.test(input) ||
    /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(input)
  ) {
    fail('INVALID_PATH', `${label} must be one local file, without UNC, URLs, or patterns`)
  }
  const portable = input.replace(/\\/g, '/')
  const driveAbsolute = /^[A-Za-z]:\//.test(portable)
  if (
    (portable.includes(':') && !driveAbsolute) ||
    (driveAbsolute && portable.slice(2).includes(':'))
  ) {
    fail(
      'INVALID_PATH',
      `${label} does not accept drive-relative paths, URL schemes, or alternate streams`
    )
  }
  if (driveAbsolute && !context.windows)
    fail('OUTSIDE_REPOSITORY', `${label} is outside the repository root`)
  let relative = portable
  if (portable.startsWith('/') || driveAbsolute) {
    if (!context.root)
      fail('ROOT_REQUIRED', `An absolute ${label} requires an explicit repository root`)
    if (context.windows && !driveAbsolute)
      fail('OUTSIDE_REPOSITORY', `${label} is outside the repository root`)
    relative = context.api.relative(context.root, portable).replace(/\\/g, '/')
  }
  relative = path.posix.normalize(relative)
  if (
    !relative ||
    relative === '.' ||
    relative === '..' ||
    relative.startsWith('../') ||
    path.posix.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative)
  ) {
    fail('OUTSIDE_REPOSITORY', `${label} must stay inside the repository root and name a file`)
  }
  return context.windows ? relative.toLowerCase() : relative
}

function validateEntries(entries, context) {
  if (!Array.isArray(entries) || entries.length === 0)
    fail('INVALID_REGISTRY', 'Registry must contain entries')
  const byId = new Map()
  const byFile = new Map()
  const metadata = new Map()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      fail('INVALID_REGISTRY', 'Every registry entry must be an object')
    const id = textValue(entry.id, 'Entry id')
    if (id !== entry.id)
      fail('INVALID_REGISTRY', 'Entry ids must not contain surrounding whitespace')
    if (byId.has(id)) fail('DUPLICATE_ID', `Duplicate registry id: ${id}`)
    if (
      !ROLES.has(entry.role) ||
      !LEVELS.has(entry.level) ||
      !RUNTIMES.has(entry.runtime) ||
      !POLICIES.has(entry.selectionPolicy)
    ) {
      fail('INVALID_REGISTRY', `Invalid role, level, runtime, or selection policy for ${id}`)
    }
    if ((entry.role === 'build') !== (entry.level === 'build'))
      fail('INVALID_REGISTRY', `Build role and level must agree for ${id}`)
    if (entry.role === 'test' && ['support', 'build'].includes(entry.level))
      fail('INVALID_REGISTRY', `Test ${id} requires a runnable level`)
    if (entry.role !== 'test' && entry.selectionPolicy !== 'support')
      fail('INVALID_REGISTRY', `Non-test ${id} must use support selection policy`)
    if (entry.role === 'test' && (entry.selectionPolicy === 'support' || entry.runtime === 'none'))
      fail('INVALID_REGISTRY', `Test ${id} requires a runnable policy and runtime`)
    if (entry.level === 'unit' && entry.runtime !== 'vitest')
      fail('INVALID_RUNTIME', `Unit test ${id} must use vitest`)
    if (entry.runtime === 'vitest' && entry.level !== 'unit')
      fail('INVALID_RUNTIME', `Vitest entry ${id} must use the unit level`)
    if (entry.level === 'gui' && !['electron', 'powershell'].includes(entry.runtime))
      fail(
        'INVALID_RUNTIME',
        `GUI test ${id} must use electron or a registered PowerShell launcher`
      )
    if (
      entry.level === 'database' &&
      !['electron-node', 'node', 'electron'].includes(entry.runtime)
    )
      fail(
        'INVALID_RUNTIME',
        `Database test ${id} requires its registered Node or Electron runtime`
      )
    const file = normalizeFile(entry.file, context, `File for ${id}`)
    if (byFile.has(file)) fail('DUPLICATE_FILE', `Duplicate registry file: ${entry.file}`)
    const lists = {}
    for (const field of LIST_FIELDS) {
      if (!Array.isArray(entry[field]))
        fail('INVALID_REGISTRY', `${field} must be an array for ${id}`)
      lists[field] = entry[field].map((value) => textValue(value, `${field} for ${id}`))
    }
    lists.sourceDependencies = lists.sourceDependencies.map((value) =>
      normalizeFile(value, context, `Source dependency for ${id}`)
    )
    lists.sourceReadDependencies = lists.sourceReadDependencies.map((value) =>
      normalizeFile(value, context, `Source-read dependency for ${id}`)
    )
    byId.set(id, entry)
    byFile.set(file, entry)
    metadata.set(id, { file, ...lists })
  }
  const visiting = new Set()
  const visited = new Set()
  function visit(id) {
    if (visiting.has(id)) fail('DEPENDENCY_CYCLE', `Build dependency cycle includes ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const requiredId of metadata.get(id).requires) {
      const required = byId.get(requiredId)
      if (!required) fail('UNKNOWN_DEPENDENCY', `${id} requires unknown entry ${requiredId}`)
      if (required.role !== 'build')
        fail('INVALID_DEPENDENCY', `${id} requires ${requiredId}, which is not a build entry`)
      visit(requiredId)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const entry of entries) visit(entry.id)
  return { byId, byFile, metadata }
}

function selectTests(entries, input, { root } = {}) {
  const selection = validateSelection(input)
  const context = pathContext(root)
  const { byId, byFile, metadata } = validateEntries(entries, context)
  const selectedIds = new Set()
  const candidateIds = new Set()
  const reasons = Object.create(null)
  const warnings = []
  const addReason = (id, reason) => {
    if (!Object.hasOwn(reasons, id)) reasons[id] = []
    if (
      !reasons[id].some(
        (item) =>
          item.type === reason.type && item.value === reason.value && item.via === reason.via
      )
    )
      reasons[id].push(reason)
  }
  const selectExplicit = (entry, type, value) => {
    if (!entry) fail('UNKNOWN_TEST', `No registered test matches ${type}: ${value}`)
    if (entry.role !== 'test')
      fail('TEST_REQUIRED', `${value} is a ${entry.role}; select a runnable test instead`)
    if (selection.level && entry.level !== selection.level)
      fail('LEVEL_MISMATCH', `${entry.id} uses level ${entry.level}, not ${selection.level}`)
    selectedIds.add(entry.id)
    addReason(entry.id, { type, value })
  }
  for (const file of selection.files)
    selectExplicit(byFile.get(normalizeFile(file, context, 'Selected file')), 'file', file)
  for (const id of selection.ids) selectExplicit(byId.get(id), 'id', id)
  for (const feature of selection.features) {
    const matches = entries.filter(
      (entry) => entry.role === 'test' && metadata.get(entry.id).features.includes(feature)
    )
    if (matches.length === 0) fail('UNKNOWN_FEATURE', `No registered tests map feature: ${feature}`)
    const focused = matches.filter(
      (entry) =>
        entry.selectionPolicy === 'focused' &&
        !['native', 'install', 'performance'].includes(entry.level)
    )
    const eligible = focused.filter((entry) => !selection.level || entry.level === selection.level)
    if (eligible.length === 0)
      fail(
        'EMPTY_FEATURE',
        `Feature ${feature} has no routine tests at the requested level; select an explicit file or id`
      )
    for (const entry of eligible) {
      selectedIds.add(entry.id)
      addReason(entry.id, { type: 'feature', value: feature })
    }
    const omitted = matches.filter((entry) => !eligible.includes(entry))
    if (omitted.length)
      warnings.push(
        `Feature ${feature} omitted ${omitted.map((entry) => entry.id).join(', ')}; explicit tests require --file or --id and other levels require a matching scope`
      )
  }

  for (const source of selection.sources) {
    const file = normalizeFile(source, context, 'Selected source')
    const affected = new Set()
    const sourceReasons = new Map()
    for (const entry of entries) {
      const data = metadata.get(entry.id)
      if (
        data.file === file ||
        data.sourceDependencies.includes(file) ||
        data.sourceReadDependencies.includes(file)
      ) {
        affected.add(entry.id)
        sourceReasons.set(entry.id, {
          type: data.sourceReadDependencies.includes(file) ? 'source-read' : 'source',
          value: source
        })
      }
    }
    let changed = true
    while (changed) {
      changed = false
      for (const entry of entries) {
        if (affected.has(entry.id)) continue
        const data = metadata.get(entry.id)
        const via = entries.find(
          (dependency) =>
            affected.has(dependency.id) &&
            (data.sourceDependencies.includes(metadata.get(dependency.id).file) ||
              data.sourceReadDependencies.includes(metadata.get(dependency.id).file) ||
              data.requires.includes(dependency.id))
        )
        if (via) {
          affected.add(entry.id)
          sourceReasons.set(entry.id, {
            type: via.role === 'build' ? 'dependency-consumer' : 'helper-consumer',
            value: source,
            via: via.id
          })
          changed = true
        }
      }
    }
    const mapped = entries.filter((entry) => entry.role === 'test' && affected.has(entry.id))
    if (mapped.length === 0)
      fail(
        'UNMAPPED_SOURCE',
        `Source ${source} has no registered test consumers; the selector will not fall back to all tests`
      )
    const eligible = mapped.filter((entry) => !selection.level || entry.level === selection.level)
    if (eligible.length === 0)
      fail(
        'SOURCE_LEVEL_MISMATCH',
        `Source ${source} has no candidates at level ${selection.level}`
      )
    for (const entry of eligible) {
      candidateIds.add(entry.id)
      addReason(entry.id, sourceReasons.get(entry.id))
    }
  }

  const selected = entries.filter((entry) => selectedIds.has(entry.id))
  const candidates = entries.filter((entry) => candidateIds.has(entry.id))
  if (selected.length === 0 && !(selection.plan && candidates.length > 0)) {
    fail(
      selection.sources.length > 0 ? 'SOURCE_REQUIRES_PLAN' : 'EMPTY_SELECTION',
      selection.sources.length > 0
        ? 'Source candidates do not authorize execution; use --plan and then select concrete tests'
        : 'Select at least one registered file, id, or feature'
    )
  }
  if (selection.sources.length > 0)
    warnings.push(
      'Source candidates are advisory and may be incomplete; only explicit file/id/feature selections enter jobs'
    )
  const dependencies = []
  const added = new Set()
  function addDependencies(entry) {
    for (const id of metadata.get(entry.id).requires) {
      addReason(id, { type: 'requires', value: entry.id })
      if (added.has(id)) continue
      const dependency = byId.get(id)
      addDependencies(dependency)
      added.add(id)
      dependencies.push(dependency)
    }
  }
  for (const entry of selected) addDependencies(entry)
  const jobs = [...dependencies, ...selected]
  const runtimePrerequisites = [
    ...new Set(jobs.flatMap((entry) => metadata.get(entry.id).runtimePrerequisites))
  ]
  return {
    selected,
    dependencies,
    jobs,
    candidates,
    reasons,
    warnings,
    runtimePrerequisites,
    buildMode: selection.build,
    planOnly: selection.plan
  }
}

module.exports = { parseSelectionArgs, selectTests, TestSelectionError }

// The executable boundary is a read-only preview. Execution and artifact reuse
// verification belong to B0c/B0d; importing the pure API has no filesystem work.
if (require.main === module) {
  try {
    const selection = parseSelectionArgs(process.argv.slice(2))
    if (!selection.plan) {
      fail(
        'PLAN_REQUIRED',
        'This entry currently previews selection only. Add --plan; no tests or builds have run.'
      )
    }
    const manifest = require('./test-manifest.cjs')
    const root = process.cwd()
    const entries = manifest.createTestRegistry({ root })
    const errors = manifest.validateTestRegistry(entries, { root })
    if (errors.length) fail('INVALID_REGISTRY', errors.join('\n'))
    const result = selectTests(entries, selection, { root })
    const describe = (entry) => ({
      id: entry.id,
      file: entry.file,
      role: entry.role,
      level: entry.level,
      runtime: entry.runtime,
      requires: entry.requires,
      runtimePrerequisites: entry.runtimePrerequisites,
      selectionPolicy: entry.selectionPolicy,
      contracts: entry.contracts,
      disposition: entry.disposition,
      limits: entry.limits
    })
    const warnings = [
      ...result.warnings,
      'This plan does not verify product assertions, build provenance, native ABI, or desktop availability.',
      'Source mappings cover recorded imports and reviewed reads; verify indirect consumers before execution.'
    ]
    if (selection.build === 'reuse-verified') {
      warnings.push(
        'reuse-verified is a requested mode only; all build dependencies remain until B0d validates their provenance.'
      )
    }
    process.stdout.write(
      JSON.stringify(
        {
          mode: 'selection-plan',
          executed: false,
          root,
          buildMode: result.buildMode,
          selected: result.selected.map(describe),
          dependencies: result.dependencies.map(describe),
          order: result.jobs.map((entry) => entry.id),
          candidates: result.candidates.map(describe),
          runtimePrerequisites: result.runtimePrerequisites,
          reasons: result.reasons,
          warnings
        },
        null,
        2
      ) + '\n'
    )
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        executed: false,
        error: { code: error.code || 'PLAN_ERROR', message: error.message }
      }) + '\n'
    )
    process.exitCode = 2
  }
}
