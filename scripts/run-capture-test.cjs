const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

function runCaptureTest({ ctest, buildDirectory, name, directory }) {
  if (!/^capture_(core|ui|ux|selection|pin_halo|polish|clipboard)$/.test(name))
    throw new Error('An exact registered CTest name is required')
  const args = ['--test-dir', buildDirectory, '-C', 'Release', '-R', '^' + name + '$']
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ABANDON_CAPTURE_TEST_RESULT_DIRECTORY: directory },
    timeout: 120_000
  }
  const selection = spawnSync(ctest, [...args, '--show-only=json-v1'], options)
  if (selection.error || selection.status !== 0) throw new Error('CTest discovery failed')
  const report = JSON.parse(selection.stdout)
  if (report.tests?.length !== 1 || report.tests[0].name !== name)
    throw new Error('CTest did not select exactly the requested target')
  writeFileSync(join(directory, 'ctest-selection.json'), JSON.stringify(report, null, 2), {
    flag: 'wx'
  })
  const result = spawnSync(
    ctest,
    [
      ...args,
      '--no-tests=error',
      '--output-on-failure',
      '--output-junit',
      join(directory, 'ctest-results.xml')
    ],
    options
  )
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) throw result.error
  return result.status === 0 ? 0 : 1
}

if (require.main === module) {
  const [ctest, buildDirectory, name, directory] = process.argv.slice(2)
  try {
    process.exitCode = runCaptureTest({ ctest, buildDirectory, name, directory })
  } catch (error) {
    process.stderr.write(error.message + '\n')
    process.exitCode = 2
  }
}
module.exports = { runCaptureTest }
