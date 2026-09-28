import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readSandboxPermissions } from '../src/main/logging/windows-sandbox-permissions.js'

describe('sandbox permission diagnostic collection', () => {
  it('passes unicode and shell metacharacters as one literal path and only inspects', async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: '\uFEFF{"status":"inspected"}\r\n' })
    const app = {
      isPackaged: true,
      getPath: () => path.join('D:/安装 软件 & (test)', 'AbandonNote.exe')
    }
    expect(
      await readSandboxPermissions(app, {
        platform: 'win32',
        resourcesPath: 'C:/resources',
        execFile: execute
      })
    ).toEqual({ status: 'inspected' })
    const [, args, options] = execute.mock.calls[0]
    expect(args.slice(-4)).toEqual([
      '-Mode',
      'Inspect',
      '-InstallRoot',
      path.dirname(app.getPath('exe'))
    ])
    expect(args).not.toContain('Repair')
    expect(options).toMatchObject({ windowsHide: true, timeout: 3000 })
    expect(options.shell).toBeUndefined()
  })

  it('does not inspect development or non-Windows installations', async () => {
    const execute = vi.fn()
    expect(
      await readSandboxPermissions({ isPackaged: false }, { platform: 'win32', execFile: execute })
    ).toBeNull()
    expect(
      await readSandboxPermissions({ isPackaged: true }, { platform: 'darwin', execFile: execute })
    ).toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })

  it('propagates failed inspection so the exporter records an unavailable field', async () => {
    const app = { isPackaged: true, getPath: () => 'C:/app/AbandonNote.exe' }
    await expect(
      readSandboxPermissions(app, {
        platform: 'win32',
        resourcesPath: 'C:/resources',
        execFile: async () => {
          throw new Error('PowerShell is blocked')
        }
      })
    ).rejects.toThrow('PowerShell is blocked')
  })
})

describe('installer integration contract', () => {
  it('ships the inspector and runs the repair hook before all NSIS launch paths', () => {
    const config = readFileSync('electron-builder.win.yml', 'utf8')
    const hook = readFileSync('build/windows/installer.nsh', 'utf8')
    const install = readFileSync(
      'node_modules/app-builder-lib/templates/nsis/installSection.nsh',
      'utf8'
    )
    expect(config).toContain('include: build/windows/installer.nsh')
    expect(config).toContain('to: diagnostics/sandbox-permissions.ps1')
    expect(hook).toContain('-Mode Repair')
    expect(hook).toContain('SetErrorLevel 1603')
    expect(hook).toContain('Abort')
    expect(hook).not.toContain('--no-sandbox')
    expect(install.indexOf('!insertmacro customInstall')).toBeGreaterThan(
      install.indexOf('!insertmacro installApplicationFiles')
    )
    expect(install.indexOf('!insertmacro customInstall')).toBeLessThan(
      install.indexOf('!macro doStartApp')
    )
  })
})
