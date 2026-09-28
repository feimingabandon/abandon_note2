import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)

// Diagnostic export only. Application startup must never mutate installation ACLs.
export async function readSandboxPermissions(app, overrides = {}) {
  const platform = overrides.platform ?? process.platform
  if (platform !== 'win32' || !app.isPackaged || typeof app.getPath !== 'function') return null
  const execute = overrides.execFile ?? execFileAsync
  const { stdout } = await execute(
    join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(overrides.resourcesPath ?? process.resourcesPath, 'diagnostics/sandbox-permissions.ps1'),
      '-Mode',
      'Inspect',
      '-InstallRoot',
      dirname(app.getPath('exe'))
    ],
    { windowsHide: true, timeout: 3000, maxBuffer: 128 * 1024 }
  )
  return JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
}
