# Compile the production hook into an isolated NSIS installer; no registry/shortcuts.
param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$Makensis
)
$ErrorActionPreference = 'Stop'
$suiteRoot = Join-Path ([IO.Path]::GetFullPath($Workspace)) ('tmp\sandbox-installer-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $suiteRoot -Force | Out-Null
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$source = @'
Unicode true
RequestExecutionLevel user
Name "Sandbox hook test"
OutFile "${TEST_ROOT}\hook-test.exe"
!include "LogicLib.nsh"
!include "${BUILD_RESOURCES_DIR}\windows\installer.nsh"
Section
  SetOutPath "$INSTDIR"
  File /oname=AbandonNote.exe "${TEST_ROOT}\fixture.txt"
  File /oname=icudtl.dat "${TEST_ROOT}\fixture.txt"
  SetOutPath "$INSTDIR\resources"
  File /oname=app.asar "${TEST_ROOT}\fixture.txt"
  CreateDirectory "$INSTDIR\locales"
  !insertmacro customInstall
  FileOpen $0 "$INSTDIR\launch-reached.txt" w
  FileWrite $0 "verified"
  FileClose $0
SectionEnd
'@
[IO.File]::WriteAllText((Join-Path $suiteRoot 'fixture.txt'), 'fixture')
$nsi = Join-Path $suiteRoot 'hook-test.nsi'
[IO.File]::WriteAllText($nsi, $source, (New-Object Text.UTF8Encoding($true)))
& $Makensis /V2 "/DTEST_ROOT=$suiteRoot" "/DBUILD_RESOURCES_DIR=$(Join-Path $Workspace 'build')" $nsi
Assert ($LASTEXITCODE -eq 0) 'NSIS compilation failed'
function Invoke-Install([string]$Root, [int]$Expected) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $suiteRoot 'hook-test.exe'
    # NSIS requires /D last, without quotes even when the path contains spaces.
    $start.Arguments = '/S /D=' + $Root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($start)
    if (-not $process.WaitForExit(90000)) {
        $process.Kill()
        throw 'Installer did not exit in 90 seconds'
    }
    Assert ($process.ExitCode -eq $Expected) "Installer exit $($process.ExitCode), expected $Expected"
}
$unicode = -join @([char]0x4e2d, [char]0x6587)
$root = Join-Path $suiteRoot "$unicode space & (app)"
Invoke-Install $root 0
Assert (Test-Path -LiteralPath (Join-Path $root 'launch-reached.txt')) 'Success did not reach launch'
$acl = Get-Acl -LiteralPath (Join-Path $root 'icudtl.dat')
Assert (@($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-15-2-2' -and $_.AccessControlType -eq 'Allow' }).Count -gt 0) 'Installed file missing grant'
Remove-Item -LiteralPath (Join-Path $root 'launch-reached.txt')
Invoke-Install $root 0
Assert (Test-Path -LiteralPath (Join-Path $root 'launch-reached.txt')) 'Reinstall did not reach launch'
Write-Output 'PASS compiled production NSIS hook: install and reinstall in Unicode/metacharacter path'
$denied = Join-Path $suiteRoot 'deny'
New-Item -ItemType Directory -Path $denied | Out-Null
$acl = Get-Acl -LiteralPath $denied
$sid = New-Object Security.Principal.SecurityIdentifier('S-1-15-2-2')
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'ReadAndExecute', 'Deny')))
Set-Acl -LiteralPath $denied -AclObject $acl
Invoke-Install $denied 1603
Assert (-not (Test-Path -LiteralPath (Join-Path $denied 'launch-reached.txt'))) 'Failed repair reached launch'
Write-Output 'PASS failure exits 1603 and never reaches launch'
Write-Output "Evidence retained at $suiteRoot"
