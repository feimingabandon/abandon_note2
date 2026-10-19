const { resolve } = require('node:path')
const manifest = require('./test-manifest.cjs')
const { parseSelectionArgs, TestSelectionError } = require('./test-selection.cjs')

const windowGroups = Object.freeze({
  all: [...manifest.windowFrameTests, ...manifest.electronFeatureTests],
  features: manifest.electronFeatureTests,
  'modal-queue': [
    'tests/modal-queue-electron.mjs',
    'tests/first-use-notice-electron.mjs',
    'tests/draft-dialog-ui-electron.mjs',
    'tests/capture-business-electron.mjs'
  ],
  capture: ['tests/capture-lifecycle-electron.mjs', 'tests/capture-business-electron.mjs'],
  'capture-host': ['tests/capture-host-electron.mjs'],
  shortcuts: ['tests/view-visibility-shortcut-electron.mjs'],
  'logging-actions': ['tests/logging-actions-electron.mjs'],
  'titlebar-native-drag': ['tests/titlebar-native-drag-electron.mjs'],
  'window-frame': manifest.windowFrameTests,
  'window-control-drag': ['tests/window-control-drag-electron.mjs']
})
const valueFlags = new Set(['--file', '--id', '--feature', '--source', '--build', '--level'])

function fail(code, message) {
  throw new TestSelectionError(code, message)
}

function unitPositionals(argv) {
  const output = []
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (typeof argument !== 'string') fail('INVALID_ARGUMENTS', 'Arguments must be strings')
    if (!argument.startsWith('-')) output.push('--file', argument)
    else {
      output.push(argument)
      if (valueFlags.has(argument) && index + 1 < argv.length) output.push(argv[++index])
    }
  }
  return output
}

function normalizeEntryArgs(kind, argv, { entries } = {}) {
  if (!Array.isArray(argv)) fail('INVALID_ARGUMENTS', 'Arguments must be an array')
  let args = [...argv]
  let collection = null
  if (kind === 'release-quality') {
    if (args.some((argument) => argument !== '--plan'))
      fail(
        'INVALID_RELEASE_SCOPE',
        'Release quality has a fixed explicit scope; only --plan is accepted'
      )
    if (!entries) fail('REGISTRY_REQUIRED', 'Release quality requires the verified registry')
    const files = entries.filter((entry) => entry.role === 'test' && entry.level === 'unit')
    if (!files.length) fail('EMPTY_SELECTION', 'Release quality has no registered unit tests')
    args = [
      ...files.flatMap((entry) => ['--file', entry.file]),
      ...[...manifest.databaseTests, ...manifest.storageTests].flatMap((file) => ['--file', file]),
      ...(args.includes('--plan') ? ['--plan'] : [])
    ]
    collection = 'release-quality-unit-database-storage'
  } else if (kind === 'unit') args = unitPositionals(args)
  else if (kind === 'window' && args[0] && !args[0].startsWith('--')) {
    collection = args.shift()
    if (!Object.hasOwn(windowGroups, collection))
      fail('UNKNOWN_COLLECTION', 'Unknown explicit Electron collection: ' + collection)
    if (args.some((argument) => argument !== '--plan'))
      fail('INVALID_COLLECTION_OPTIONS', 'An Electron collection accepts only --plan')
    args = [...windowGroups[collection].flatMap((file) => ['--file', file]), ...args]
  } else if (!['focused', 'database', 'window', 'capture-native'].includes(kind))
    fail('UNKNOWN_ENTRY', 'Unknown test entry: ' + kind)

  const selection = parseSelectionArgs(args)
  if (
    kind !== 'focused' &&
    ((!selection.files.length && !selection.ids.length) ||
      selection.features.length ||
      selection.sources.length)
  )
    fail('EXPLICIT_TARGET_REQUIRED', kind + ' requires explicit test files or IDs')
  const expectedLevel = { unit: 'unit', database: 'database', 'capture-native': 'native' }[kind]
  if (expectedLevel) {
    if (selection.level && selection.level !== expectedLevel)
      fail('ENTRY_LEVEL_MISMATCH', kind + ' cannot override its test level')
    if (!selection.level) args.push('--level', expectedLevel)
  }
  return { kind, args, collection, scope: collection ? 'explicit-collection' : 'explicit-focused' }
}

function createEntryPlan(kind, argv, options = {}) {
  const root = options.root || resolve(__dirname, '..')
  const entries = options.entries || manifest.createTestRegistry({ root })
  const entry = normalizeEntryArgs(kind, argv, { entries })
  const focused = options.focused || require('./run-focused-tests.cjs')
  const plan = focused.createFocusedPlan(entry.args, { ...options, root, entries })
  if (
    kind === 'window' &&
    plan.selected.some((item) => item.runtime !== 'electron' && item.level !== 'gui')
  )
    fail(
      'ENTRY_RUNTIME_MISMATCH',
      'The Electron window entry requires registered Electron or GUI targets'
    )
  if (kind === 'capture-native' && plan.selected.some((item) => item.runtime !== 'qt'))
    fail(
      'ENTRY_RUNTIME_MISMATCH',
      'Capture native requires a concrete registered Qt test ID or file'
    )
  return { ...plan, entry: { kind, scope: entry.scope, collection: entry.collection } }
}

async function main(kind, argv = process.argv.slice(3), options = {}) {
  const plan = createEntryPlan(kind, argv, options)
  if (plan.planOnly || plan.entry.scope === 'explicit-collection')
    process.stdout.write(JSON.stringify({ ...plan, executed: false }, null, 2) + '\n')
  if (plan.planOnly) return { ...plan, exitCode: 0 }
  const focused = options.focused || require('./run-focused-tests.cjs')
  const result = await focused.executeFocusedPlan(plan, options)
  process.stdout.write(
    JSON.stringify({ directory: result.directory, ...result.summary }, null, 2) + '\n'
  )
  process.exitCode = result.exitCode
  return result
}

function reportError(error) {
  process.stderr.write(
    JSON.stringify({
      executed: Boolean(error.executed),
      error: { code: error.code || 'TEST_ENTRY_ERROR', message: error.message }
    }) + '\n'
  )
  process.exitCode = 2
}

if (require.main === module) main(process.argv[2]).catch(reportError)

module.exports = { windowGroups, normalizeEntryArgs, createEntryPlan, main, reportError }
