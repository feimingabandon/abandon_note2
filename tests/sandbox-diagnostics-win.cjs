// Run against an unpacked Windows test package in a normal desktop environment.
const assert = require('node:assert/strict')
const path = require('node:path')
const { existsSync, readFileSync } = require('node:fs')

async function main() {
  assert.equal(process.platform, 'win32')
  assert.ok(process.argv[2], 'Supply the unpacked Windows package directory')
  const root = path.resolve(process.argv[2])
  const { readSandboxPermissions } =
    await import('../src/main/logging/windows-sandbox-permissions.js')
  const app = { isPackaged: true, getPath: () => path.join(root, 'AbandonNote.exe') }
  async function inspect() {
    const result = await readSandboxPermissions(app, {
      resourcesPath: path.join(root, 'resources')
    })
    assert.equal(result.status, 'inspected')
    assert.equal(result.checkedFiles.length, 6)
    assert.equal(result.backup, undefined)
    assert.ok(
      result.checkedFiles.every((entry) => entry.error === null),
      JSON.stringify(result.checkedFiles.filter((entry) => entry.error))
    )
  }
  await inspect()
  console.log('PASS packaged inspector: six ACL entries without full DACL backup')
  const ps7Modules = [
    ...(process.env.PSModulePath || '').split(path.delimiter),
    path.join(process.env.ProgramFiles, 'PowerShell/7/Modules')
  ].find((directory) => {
    const manifest = path.join(
      directory,
      'Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1'
    )
    return (
      existsSync(manifest) &&
      /CompatiblePSEditions\s*=\s*@\(\s*['"]Core['"]/i.test(readFileSync(manifest, 'utf8'))
    )
  })
  if (ps7Modules) {
    // Reproduce the parent-process environment that used to break Get-Acl autoload.
    process.env.PSModulePath = ps7Modules
    await inspect()
    console.log('PASS inspector with inherited PowerShell 7 module path')
  } else {
    console.log('SKIP PowerShell 7 module path: PowerShell 7 is not installed')
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
