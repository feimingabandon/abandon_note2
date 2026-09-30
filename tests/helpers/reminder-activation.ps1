param([Parameter(Mandatory=$true)][string]$ExecutablePath,
  [Parameter(Mandatory=$true)][string]$AppId,
  [ValidateSet('cleanup')][string]$Action = 'cleanup')
$ErrorActionPreference = 'Stop'
if ($AppId -notmatch '^AbandonReminderProbe-[a-f0-9-]+$') { throw 'Only isolated reminder probes are allowed' }
$resolvedProbeExe = [IO.Path]::GetFullPath($ExecutablePath)
if ([IO.Path]::GetFileName([IO.Path]::GetDirectoryName($resolvedProbeExe)) -ne $AppId) { throw 'Probe directory mismatch' }
$registryRoot = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes\CLSID')
$matches = @($registryRoot.GetSubKeyNames() | Where-Object {
  $key = $registryRoot.OpenSubKey($_ + '\LocalServer32')
  try { $key -and $key.GetValue('') -eq $resolvedProbeExe } finally { if ($key) { $key.Dispose() } }
})
$registryRoot.Dispose()
foreach ($id in $matches) {
  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\Classes\CLSID\' + $id)
}
$shell = New-Object -ComObject WScript.Shell
foreach ($name in @($AppId,'Electron')) {
  $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) ($name + '.lnk')
  if (Test-Path -LiteralPath $shortcut) {
    if ($shell.CreateShortcut($shortcut).TargetPath -eq $resolvedProbeExe) { Remove-Item -LiteralPath $shortcut -Force }
  }
}