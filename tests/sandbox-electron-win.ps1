# A real Electron runtime in a private fixture, with GPU and renderer sandboxes enabled.
param([Parameter(Mandatory = $true)][string]$Workspace)
$ErrorActionPreference = 'Stop'
$suiteRoot = Join-Path ([IO.Path]::GetFullPath($Workspace)) ('tmp\sandbox-electron-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $suiteRoot 'runtime'
$source = Join-Path $suiteRoot 'app-source'
New-Item -ItemType Directory -Path $root, $source -Force | Out-Null
Copy-Item -Path (Join-Path $Workspace 'node_modules\electron\dist\*') -Destination $root -Recurse
Rename-Item -LiteralPath (Join-Path $root 'electron.exe') -NewName 'AbandonNote.exe'
Remove-Item -LiteralPath (Join-Path $root 'resources\default_app.asar')
$main = @'
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
app.setPath('userData', process.env.ABANDON_ACL_SMOKE_PROFILE)
const output = process.env.ABANDON_ACL_SMOKE_OUTPUT
const timer = setTimeout(() => { fs.writeFileSync(output, JSON.stringify({ error: 'timeout' })); app.exit(1) }, 20000)
app.whenReady().then(async () => {
  const renderer = new Promise(resolve => ipcMain.once('sandbox-ready', (_, info) => resolve(info)))
  const window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: path.join(__dirname, 'preload.cjs')
  } })
  await window.loadURL('data:text/html,<html><body>Sandbox smoke</body></html>')
  const rendererInfo = await renderer
  const text = await window.webContents.executeJavaScript('document.body.innerText')
  const gpu = await app.getGPUInfo('complete')
  const result = { renderer: rendererInfo, text, gpuSandboxed: gpu.auxAttributes?.sandboxed,
    featureStatus: app.getGPUFeatureStatus(), versions: process.versions }
  fs.writeFileSync(output, JSON.stringify(result, null, 2))
  clearTimeout(timer)
  app.exit(rendererInfo.sandboxed && result.gpuSandboxed && text === 'Sandbox smoke' ? 0 : 1)
}).catch(error => { fs.writeFileSync(output, JSON.stringify({error: String(error)})); app.exit(1) })
'@
[IO.File]::WriteAllText((Join-Path $source 'main.cjs'), $main)
[IO.File]::WriteAllText((Join-Path $source 'package.json'), '{"name":"sandbox-smoke","version":"1.0.0","main":"main.cjs"}')
[IO.File]::WriteAllText((Join-Path $source 'preload.cjs'), "require('electron').ipcRenderer.send('sandbox-ready', { sandboxed: process.sandboxed })")
$node = 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node (Join-Path $Workspace 'node_modules\@electron\asar\bin\asar.js') pack $source (Join-Path $root 'resources\app.asar')
if ($LASTEXITCODE -ne 0) { throw 'ASAR fixture creation failed' }
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Workspace 'build\windows\sandbox-permissions.ps1') -Mode Repair -InstallRoot $root -ReportPath (Join-Path $suiteRoot 'acl-report.json')
if ($LASTEXITCODE -ne 0) { throw 'Runtime permission repair failed' }
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = Join-Path $root 'AbandonNote.exe'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
$start.EnvironmentVariables['ABANDON_ACL_SMOKE_PROFILE'] = Join-Path $suiteRoot 'profile'
$start.EnvironmentVariables['ABANDON_ACL_SMOKE_OUTPUT'] = Join-Path $suiteRoot 'smoke.json'
$process = [Diagnostics.Process]::Start($start)
if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Electron smoke timed out' }
if ($process.ExitCode -ne 0) { throw "Electron smoke failed ($($process.ExitCode)); evidence: $suiteRoot" }
Write-Output 'PASS real Electron: renderer sandbox, GPU sandbox, page load and JavaScript execution'
Write-Output "Evidence retained at $suiteRoot"
