# Scoped Windows ACL integration. Only fixtures under the supplied workspace are changed.
param([Parameter(Mandatory = $true)][string]$Workspace)
$ErrorActionPreference = 'Stop'
$workspacePath = [IO.Path]::GetFullPath($Workspace).TrimEnd('\')
$suiteRoot = Join-Path $workspacePath ('tmp\sandbox-acl-' + [guid]::NewGuid().ToString('N'))
$helper = Join-Path $workspacePath 'build\windows\sandbox-permissions.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
New-Item -ItemType Directory -Path $suiteRoot -Force | Out-Null
$sid = New-Object Security.Principal.SecurityIdentifier('S-1-15-2-2')
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function New-Fixture([string]$Name) {
    $root = Join-Path $suiteRoot $Name
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    # Ensure the fixture actually lacks the grant, even on hosts whose parents already have it.
    $acl = Get-Acl -LiteralPath $root
    $acl.SetAccessRuleProtection($true, $true)
    foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
        if ($rule.IdentityReference.Value -eq $sid.Value) { $acl.RemoveAccessRuleSpecific($rule) }
    }
    [IO.Directory]::SetAccessControl($root, $acl)
    New-Item -ItemType Directory -Path (Join-Path $root 'resources') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $root 'locales') -Force | Out-Null
    foreach ($file in @('AbandonNote.exe', 'icudtl.dat', 'resources\app.asar', 'locales\zh-CN.pak')) {
        [IO.File]::WriteAllText((Join-Path $root $file), 'fixture')
    }
    return $root
}
function Invoke-Helper([string]$Root, [string]$Mode, [int]$Expected) {
    $report = Join-Path $suiteRoot ([guid]::NewGuid().ToString('N') + '.json')
    $output = & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Mode $Mode -InstallRoot $Root -ReportPath $report
    $code = $LASTEXITCODE
    Assert ($code -eq $Expected) "Unexpected exit $code (expected $Expected): $output"
    if ($Mode -eq 'Inspect') { return ($output | ConvertFrom-Json) }
    return (Get-Content -LiteralPath $report -Raw | ConvertFrom-Json)
}
try {
    # Build Unicode at runtime so Windows PowerShell 5.1 does not depend on script encoding.
    $unicode = -join @([char]0x4e2d, [char]0x6587)
    $root = New-Fixture "$unicode space & (app)"
    $ownerBefore = (Get-Acl -LiteralPath $root).Owner
    $daclBefore = (Get-Acl -LiteralPath $root).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $sddlBefore = (Get-Acl -LiteralPath $root).Sddl
    $inspection = Invoke-Helper $root Inspect 0
    Assert ((Get-Acl -LiteralPath $root).Sddl -eq $sddlBefore) 'Inspect changed the ACL'
    Assert ($inspection.checkedFiles.Count -eq 6) 'Missing diagnostic entries'
    Assert (-not $inspection.checkedFiles[0].hasRequiredAllow) 'Fixture already had the required grant'
    Assert ($null -eq $inspection.backup) 'Inspector exported full DACL backup'
    $first = Invoke-Helper $root Repair 0
    Assert ($first.status -eq 'verified') 'Repair not verified'
    Assert ($first.backup.Count -eq 7) 'Incomplete pre-change backup'
    Assert ($first.backup[0].dacl -eq $daclBefore) 'Backup did not capture the original DACL'
    Assert ((Get-Acl -LiteralPath $root).Owner -eq $ownerBefore) 'Owner was changed'
    Assert (@($first.checkedFiles | Where-Object { -not $_.hasRequiredAllow }).Count -eq 0) 'Child inheritance missing'
    $sddlAfter = (Get-Acl -LiteralPath $root).Sddl
    $daclAfter = (Get-Acl -LiteralPath $root).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $second = Invoke-Helper $root Repair 0
    Assert ((Get-Acl -LiteralPath $root).Sddl -eq $sddlAfter) 'Repeat repair is not idempotent'
    Assert ($second.backup.Count -eq 7 -and $second.backup[0].dacl -eq $daclAfter) 'Second backup did not capture the pre-change DACL'
    # New files from a subsequent upgrade inherit the same grant.
    [IO.File]::WriteAllText((Join-Path $root 'resources\upgrade.dat'), 'new')
    $upgrade = Invoke-Helper $root Repair 0
    Assert ($upgrade.checkedFiles.Count -eq 8) 'Upgrade entry missing'
    Assert (($upgrade.checkedFiles | Where-Object path -eq 'resources\upgrade.dat').hasRequiredAllow) 'Upgrade file did not inherit'
    Write-Output 'PASS Unicode, spaces, shell metacharacters, inspect-only, backup, inheritance, repeat repair, upgrade'

    $denied = New-Fixture 'deny'
    $acl = Get-Acl -LiteralPath $denied
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'ReadAndExecute', 'Deny')
    $acl.AddAccessRule($rule)
    [IO.Directory]::SetAccessControl($denied, $acl)
    $before = (Get-Acl -LiteralPath $denied).Sddl
    $failure = Invoke-Helper $denied Repair 1
    Assert ($failure.error -like '*denied*') 'Explicit deny was not reported'
    Assert ((Get-Acl -LiteralPath $denied).Sddl -eq $before) 'Existing deny was modified'
    Write-Output 'PASS explicit deny preserved and reported'

    $protected = New-Fixture 'protected'
    $file = Join-Path $protected 'icudtl.dat'
    $acl = Get-Acl -LiteralPath $file
    $acl.SetAccessRuleProtection($true, $true)
    foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
        if ($rule.IdentityReference.Value -eq $sid.Value) { $acl.RemoveAccessRuleSpecific($rule) }
    }
    [IO.File]::SetAccessControl($file, $acl)
    $before = (Get-Acl -LiteralPath $protected).Sddl
    $failure = Invoke-Helper $protected Repair 1
    Assert ($failure.error -like '*Cannot inherit*') 'Protected file not reported'
    Assert ((Get-Acl -LiteralPath $protected).Sddl -eq $before) 'Root modified before preflight passed'
    Write-Output 'PASS protected child is rejected without resetting inheritance'

    $linked = New-Fixture 'linked'
    $outside = Join-Path $suiteRoot 'outside'
    New-Item -ItemType Directory -Path $outside | Out-Null
    $before = (Get-Acl -LiteralPath $outside).Sddl
    New-Item -ItemType Junction -Path (Join-Path $linked 'escape') -Target $outside | Out-Null
    $failure = Invoke-Helper $linked Repair 1
    Assert ($failure.error -like '*Reparse point*') 'Junction was not rejected'
    Assert ((Get-Acl -LiteralPath $outside).Sddl -eq $before) 'Outside ACL changed'
    # Remove just the junction before any recursive fixture cleanup.
    [IO.Directory]::Delete((Join-Path $linked 'escape'))
    Write-Output 'PASS junction rejected; external target untouched'

    $missing = New-Fixture 'missing'
    Remove-Item -LiteralPath (Join-Path $missing 'icudtl.dat')
    $failure = Invoke-Helper $missing Repair 1
    Assert ($failure.status -eq 'failed') 'Incomplete app accepted'
    Write-Output 'PASS missing required file rejected'

    $unwritableReport = New-Fixture 'report-failure'
    $before = (Get-Acl -LiteralPath $unwritableReport).Sddl
    # An existing directory cannot be overwritten with the required backup file.
    # Windows PowerShell surfaces native stderr as an ErrorRecord; this stderr is expected.
    $ErrorActionPreference = 'Continue'
    $output = & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Mode Repair -InstallRoot $unwritableReport -ReportPath $suiteRoot 2>&1
    $failureCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    Assert ($failureCode -eq 1) 'Unwritable backup was accepted'
    Assert ((Get-Acl -LiteralPath $unwritableReport).Sddl -eq $before) 'ACL changed despite backup failure'
    Write-Output 'PASS backup write failure prevents permission changes'
    Write-Output "Evidence retained at $suiteRoot"
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    [Console]::Error.WriteLine($_.ScriptStackTrace)
    [Console]::Error.WriteLine("Evidence retained at $suiteRoot")
    exit 1
}
