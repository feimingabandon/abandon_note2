import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import provenance from '../scripts/test-build-provenance.cjs'

const { createBuildSnapshot, writeBuildProof, verifyBuildProof } = provenance
const temporaryDirectories = []

function privateDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'abandon-build-proof-unit-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory)
    expect(target.startsWith(resolve(tmpdir()) + sep)).toBe(true)
    expect(relative(tmpdir(), target).startsWith('abandon-build-proof-unit-')).toBe(true)
    rmSync(target, { recursive: true, force: true })
  }
})

function file(root, name, content) {
  const target = join(root, name)
  const parent = target.slice(0, target.lastIndexOf(sep))
  mkdirSync(parent, { recursive: true })
  writeFileSync(target, content)
  return target
}

function fixture({ output = true } = {}) {
  const root = privateDirectory()
  const external = privateDirectory()
  file(root, 'src/main.js', 'export const result = 7\n')
  file(root, 'src/shared.js', 'export const shared = 1\n')
  file(root, 'config.json', '{"target":"test"}\n')
  file(root, 'package-lock.json', '{"lockfileVersion":3}\n')
  file(external, 'compiler.exe', 'fixture compiler v1')
  if (output) {
    file(root, 'out/app/main.js', 'compiled fixture\n')
    file(root, 'out/app/assets/value.txt', 'asset\n')
  }
  return {
    root,
    id: 'build-fixture',
    mode: { target: 'app', configuration: 'test', qtTargets: [] },
    inputs: ['src', 'config.json', 'package-lock.json'],
    outputs: ['out/app'],
    toolchain: {
      files: [{ name: 'compiler', path: join(external, 'compiler.exe') }],
      metadata: { version: 'fixture-v1' }
    },
    closure: { complete: true, basis: 'Fixture explicitly contains all compiler inputs' },
    abi: { declared: 18 },
    proofDirectory: 'tmp/build-proofs'
  }
}

function issue(options, extra = {}) {
  const before = createBuildSnapshot(options)
  return writeBuildProof({ ...options, before, ...extra })
}

describe('content-based build provenance', () => {
  it('reads a plan snapshot without creating proof directories, including not-yet-built outputs', () => {
    const options = fixture({ output: false })
    const before = readdirSync(options.root).sort()
    const snapshot = createBuildSnapshot(options)
    expect(snapshot.outputs).toEqual([{ path: 'out/app', kind: 'missing' }])
    expect(snapshot.inputs.find((entry) => entry.path === 'src/main.js').sha256).toBe(
      createHash('sha256').update('export const result = 7\n').digest('hex')
    )
    expect(readdirSync(options.root).sort()).toEqual(before)
    expect(existsSync(join(options.root, options.proofDirectory))).toBe(false)
    expect(Object.isFrozen(snapshot.inputs)).toBe(true)
  })

  it('accepts newly produced output only after unchanged pre-build inputs and explicit closure', () => {
    const options = fixture({ output: false })
    const before = createBuildSnapshot(options)
    file(options.root, 'out/app/main.js', 'built fixture')
    const proof = writeBuildProof({ ...options, before })
    expect(verifyBuildProof(options)).toMatchObject({
      verified: true,
      status: 'verified',
      proofPath: proof.proofPath,
      abiStatus: 'declared-only',
      validationStatus: 'not-performed'
    })
    expect(readFileSync(proof.proofPath, 'utf8')).toContain('abandon-test-build-proof/v1')
  })

  it('records each successful attempt independently without replacing the first report', () => {
    const options = fixture()
    const first = issue(options)
    const firstContent = readFileSync(first.proofPath, 'utf8')
    const second = issue(options)
    expect(first.proofPath).not.toBe(second.proofPath)
    expect(readFileSync(first.proofPath, 'utf8')).toBe(firstContent)
    expect(readdirSync(join(options.root, options.proofDirectory, options.id))).toHaveLength(2)
    expect(verifyBuildProof(options).verified).toBe(true)
  })

  it.each([
    ['source edit', (options) => file(options.root, 'src/main.js', 'changed source')],
    ['source added', (options) => file(options.root, 'src/new.js', 'new dependency')],
    ['source removed', (options) => rmSync(join(options.root, 'src/shared.js'))],
    ['lockfile edit', (options) => file(options.root, 'package-lock.json', '{"changed":true}')],
    ['configuration edit', (options) => file(options.root, 'config.json', '{"target":"other"}')],
    ['output edit', (options) => file(options.root, 'out/app/main.js', 'modified artifact')],
    ['output added', (options) => file(options.root, 'out/app/new.dll', 'unknown deployment')],
    ['output removed', (options) => rmSync(join(options.root, 'out/app/assets/value.txt'))],
    ['tool edit', (options) => writeFileSync(options.toolchain.files[0].path, 'compiler v2')],
    ['mode edit', (options) => (options.mode.qtTargets = ['CaptureUnit'])],
    ['ABI declaration edit', (options) => (options.abi.declared = 19)]
  ])('rejects reuse after %s without silently rebuilding', (_label, mutate) => {
    const options = fixture()
    issue(options)
    mutate(options)
    expect(verifyBuildProof(options)).toMatchObject({
      verified: false,
      status: 'unverified',
      reasons: ['BUILD_STATE_CHANGED']
    })
  })

  it('reports missing proof and unknown closure distinctly and never issues an unknown proof', () => {
    const options = fixture()
    expect(verifyBuildProof(options).reasons).toEqual(['MISSING_PROOF'])
    options.closure.complete = false
    const before = createBuildSnapshot(options)
    expect(verifyBuildProof(options).reasons).toEqual(['UNKNOWN_CLOSURE'])
    expect(() => writeBuildProof({ ...options, before })).toThrow('closure')
    expect(existsSync(join(options.root, options.proofDirectory))).toBe(false)
  })

  it('refuses issuance if the build changed source inputs, tool files or its declared mode', () => {
    for (const change of [
      (options) => file(options.root, 'src/main.js', 'drift during compilation'),
      (options) => writeFileSync(options.toolchain.files[0].path, 'replaced compiler'),
      (options) => (options.mode.configuration = 'release')
    ]) {
      const options = fixture()
      const before = createBuildSnapshot(options)
      change(options)
      expect(() => writeBuildProof({ ...options, before })).toThrow('changed during the build')
      expect(existsSync(join(options.root, options.proofDirectory))).toBe(false)
    }
  })

  it('rejects missing declared outputs and does not leave a reusable proof', () => {
    const options = fixture({ output: false })
    const before = createBuildSnapshot(options)
    expect(() => writeBuildProof({ ...options, before })).toThrow('Every declared output')
    expect(existsSync(join(options.root, options.proofDirectory))).toBe(false)
    expect(verifyBuildProof(options).reasons).toEqual(['MISSING_OUTPUT'])
  })

  it('requires real hash-matching evidence when validation is requested and keeps ABI declaration distinct', () => {
    const options = fixture()
    issue(options)
    expect(
      verifyBuildProof({ ...options, requireValidation: 'native-runtime-probe' }).reasons
    ).toEqual(['MISSING_VALIDATION'])
    const evidence = file(options.root, 'tmp/probe-result.json', '{"actualAbi":18,"passed":true}')
    const validation = {
      status: 'passed',
      kind: 'native-runtime-probe',
      evidence: [
        {
          path: 'tmp/probe-result.json',
          sha256: createHash('sha256').update(readFileSync(evidence)).digest('hex')
        }
      ]
    }
    const proof = issue(options, { validation })
    expect(verifyBuildProof({ ...options, requireValidation: validation.kind })).toMatchObject({
      verified: true,
      proofPath: proof.proofPath,
      abiStatus: 'declared-only',
      validationStatus: 'passed'
    })
    writeFileSync(evidence, 'tampered evidence')
    expect(verifyBuildProof(options).reasons).toEqual(['INVALID_VALIDATION'])
    expect(() => issue(options, { validation })).toThrow('does not match')
  })

  it('blocks corrupt latest proof instead of falling back to an older successful record', () => {
    const options = fixture()
    const older = issue(options)
    const newest = issue(options)
    writeFileSync(newest.proofPath, '{"schema":"invalid"}')
    expect(verifyBuildProof(options).verified).toBe(false)
    expect(readFileSync(older.proofPath, 'utf8')).toContain('abandon-test-build-proof/v1')
  })
})

describe('provenance filesystem boundaries', () => {
  it.each(['../outside', 'C:/outside', '//server/share', 'src/*.js', 'src/main.js:stream'])(
    'rejects nonliteral or escaping source path %s before issuing a proof',
    (source) => {
      const options = fixture()
      expect(verifyBuildProof({ ...options, inputs: [source] })).toMatchObject({
        verified: false,
        reasons: ['UNSAFE_PATH']
      })
      expect(existsSync(join(options.root, options.proofDirectory))).toBe(false)
    }
  )

  it('never traverses source or output junctions to outside files', () => {
    for (const descriptor of ['inputs', 'outputs']) {
      const options = fixture()
      const outside = privateDirectory()
      file(outside, 'unrelated.txt', 'outside repository')
      symlinkSync(outside, join(options.root, 'linked'), 'junction')
      expect(verifyBuildProof({ ...options, [descriptor]: ['linked'] })).toMatchObject({
        verified: false,
        reasons: ['LINK_PATH']
      })
    }
  })

  it('refuses a proof directory junction before writing anything outside the repository', () => {
    const options = fixture()
    const outside = privateDirectory()
    symlinkSync(outside, join(options.root, 'proof-link'), 'junction')
    const before = createBuildSnapshot(options)
    expect(() => writeBuildProof({ ...options, proofDirectory: 'proof-link', before })).toThrow(
      'Links/junctions'
    )
    expect(readdirSync(outside)).toEqual([])
  })

  it('refuses hard-linked source, outputs and proof reports', () => {
    for (const target of ['src/main.js', 'out/app/main.js']) {
      const options = fixture()
      linkSync(join(options.root, target), join(options.root, 'hard-link'))
      expect(verifyBuildProof(options).reasons).toEqual(['HARD_LINK'])
    }
    const options = fixture()
    const proof = issue(options)
    linkSync(proof.proofPath, join(options.root, 'linked-proof'))
    expect(verifyBuildProof(options).reasons).toEqual(['HARD_LINK'])
  })

  it('allows only explicitly named external tool files, rejecting external directory traversal', () => {
    const options = fixture()
    expect(createBuildSnapshot(options).toolchain.files[0].sha256).toBe(
      createHash('sha256').update('fixture compiler v1').digest('hex')
    )
    const toolDirectory = privateDirectory()
    expect(
      verifyBuildProof({
        ...options,
        toolchain: { files: [{ name: 'directory', path: toolDirectory }] }
      }).reasons
    ).toEqual(['INVALID_DESCRIPTOR'])
  })

  it('hashes an explicitly named external system-tool hard link read-only', () => {
    const options = fixture()
    const compiler = options.toolchain.files[0].path
    linkSync(compiler, compiler + '.system-copy')
    issue(options)
    expect(verifyBuildProof(options).verified).toBe(true)
    expect(readFileSync(compiler, 'utf8')).toBe('fixture compiler v1')
  })

  it('refuses proof output inside declared input/output trees before creating it', () => {
    const options = fixture()
    const before = createBuildSnapshot(options)
    expect(() => writeBuildProof({ ...options, before, proofDirectory: 'src/proofs' })).toThrow(
      'outside input/output'
    )
    expect(existsSync(join(options.root, 'src/proofs'))).toBe(false)
  })
})
