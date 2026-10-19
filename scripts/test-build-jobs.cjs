const { writeFileSync } = require('node:fs')
const { join, delimiter } = require('node:path')
const provenance = require('./test-build-provenance.cjs')

function comparable(snapshot) {
  const input = { ...snapshot }
  delete input.outputs
  delete input.fingerprint
  return JSON.stringify(input)
}

function createBuildJob(
  entry,
  plan,
  { nodeExecutable = process.execPath, qtNames = [], env = process.env } = {}
) {
  let descriptor, before, verification
  const describe = () =>
    require('./test-build-descriptors.cjs').describeBuild({
      root: plan.root,
      id: entry.id,
      nodeExecutable,
      qtNames,
      env
    })
  const configured = describe()
  const proofDirectory = 'tmp/test-build-proofs'
  return {
    id: entry.id,
    requires: entry.requires,
    command: plan.buildMode === 'reuse-verified' ? nodeExecutable : configured.command,
    resultKind: 'build',
    resultPolicy: 'required',
    timeoutMs: 600_000,
    preparationTimeoutMs: 60_000,
    assessmentTimeoutMs: 60_000,
    metadata: { target: entry.file, buildMode: plan.buildMode, qtNames },
    prepare({ directory }) {
      descriptor = describe()
      before = provenance.createBuildSnapshot(descriptor.snapshotOptions)
      writeFileSync(join(directory, 'build-before.json'), JSON.stringify(before, null, 2))
      if (plan.buildMode === 'reuse-verified') {
        verification = provenance.verifyBuildProof({
          ...descriptor.snapshotOptions,
          proofDirectory,
          ...(descriptor.requireValidation
            ? { requireValidation: descriptor.requireValidation }
            : {})
        })
        writeFileSync(
          join(directory, 'reuse-verification.json'),
          JSON.stringify(verification, null, 2)
        )
        if (!verification.verified)
          throw new Error('Build reuse refused: ' + verification.reasons.join(', '))
        return { args: ['-e', 'process.exit(0)'] }
      }
      if (descriptor.command !== configured.command)
        throw new Error('Build descriptor command does not match the registered runtime')
      return { args: descriptor.args, ...(descriptor.env ? { env: descriptor.env } : {}) }
    },
    assessResult(context) {
      if (context.processResult.status !== 'passed')
        return {
          status: 'failed',
          mode: 'build-process',
          reason: 'Build process did not complete successfully'
        }
      const currentDescriptor = describe()
      const after = provenance.createBuildSnapshot(currentDescriptor.snapshotOptions)
      writeFileSync(join(context.directory, 'build-after.json'), JSON.stringify(after, null, 2))
      if (comparable(before) !== comparable(after))
        return {
          status: 'unproven',
          mode: 'build-input-drift',
          reason: 'Inputs/toolchain/mode changed while building'
        }
      if (
        after.outputs.some((item) => item.kind === 'missing') ||
        !after.outputs.some((item) => item.kind === 'file')
      )
        return {
          status: 'unproven',
          mode: 'build-output-missing',
          reason: 'Declared build outputs are absent or empty'
        }
      if (plan.buildMode === 'reuse-verified') {
        const final = provenance.verifyBuildProof({
          ...currentDescriptor.snapshotOptions,
          proofDirectory,
          ...(currentDescriptor.requireValidation
            ? { requireValidation: currentDescriptor.requireValidation }
            : {})
        })
        if (!final.verified)
          return { status: 'unproven', mode: 'build-reuse', reason: final.reasons.join(', ') }
        return {
          status: 'passed',
          mode: 'build-reuse-verified',
          provenance: final,
          limits: ['Build provenance is not a business assertion']
        }
      }
      const proof = after.closure.complete
        ? provenance.writeBuildProof({
            ...currentDescriptor.snapshotOptions,
            before,
            proofDirectory
          })
        : null
      const result = {
        status: 'passed',
        mode: 'build-current-inputs',
        provenance: {
          status: proof ? 'verified' : 'unverified',
          proofPath: proof?.proofPath,
          reason: proof
            ? 'Input and toolchain closure matched the completed build'
            : after.closure.basis,
          abiStatus: 'declared-only'
        },
        limits: [
          'Compilation and output existence do not prove desktop/native business behavior',
          ...(proof
            ? []
            : [
                'Native toolchain closure is incomplete; these outputs cannot be reused as verified'
              ])
        ]
      }
      writeFileSync(join(context.directory, 'build-result.json'), JSON.stringify(result, null, 2))
      return result
    }
  }
}

function createQtJob(
  entry,
  plan,
  { nodeExecutable = process.execPath, qtNames, env = process.env }
) {
  const name = 'capture_' + /\/([^/]+)_test\.cpp$/.exec(entry.file)[1]
  let descriptor
  return {
    id: entry.id,
    requires: entry.requires,
    command: nodeExecutable,
    resultPolicy: 'required',
    timeoutMs: 180_000,
    metadata: { target: entry.file, ctestName: name },
    prepare({ directory }) {
      descriptor = require('./test-build-descriptors.cjs').describeBuild({
        root: plan.root,
        id: 'build-capture',
        nodeExecutable,
        qtNames,
        env
      })
      return {
        args: [
          join(plan.root, 'scripts/run-capture-test.cjs'),
          descriptor.ctest,
          descriptor.buildDirectory,
          name,
          directory
        ],
        env: { PATH: join(descriptor.qtRoot, 'bin') + delimiter + env.PATH }
      }
    },
    assessResult: (context) =>
      require('./test-result-adapters.cjs').assessQtReport(context, { name, file: entry.file })
  }
}

module.exports = { createBuildJob, createQtJob }
