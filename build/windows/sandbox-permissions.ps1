# Windows PowerShell 5.1. Repair is installer-only; Inspect never changes an ACL.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Inspect', 'Repair')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$sandboxSid = 'S-1-15-2-2'
$requiredRights = [int][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
$inheritOnly = [System.Security.AccessControl.PropagationFlags]::InheritOnly
$canWriteReport = $false
$report = [ordered]@{
    schemaVersion = 1
    mode = $Mode
    status = 'pending'
    installRoot = $null
    sid = $sandboxSid
    # This verifies our ACL policy, not an effective-access check of a Chromium token.
    verification = 'required-allow-and-known-deny-rules'
    checkedFiles = @()
    backup = @()
    error = $null
}

function Assert-PlainPath([string]$Path) {
    $cursor = [System.IO.Path]::GetFullPath($Path)
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "Reparse point is not supported: $cursor"
        }
        $parent = [System.IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function Read-PermissionSummary([string]$Path, [string]$RelativePath) {
    try {
        Assert-PlainPath $Path
        $acl = Get-Acl -LiteralPath $Path
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $allowMask = 0
        $knownDenyMask = 0
        $packageRules = @()
        $denyCount = 0
        foreach ($rule in $rules) {
            $sid = $rule.IdentityReference.Value
            $applies = ($rule.PropagationFlags -band $inheritOnly) -eq 0
            $rights = [int]$rule.FileSystemRights
            if ($rule.AccessControlType -eq 'Deny') { $denyCount++ }
            if ($applies -and $sid -eq $sandboxSid -and $rule.AccessControlType -eq 'Allow') {
                $allowMask = $allowMask -bor $rights
            }
            if ($applies -and $sid -in @('S-1-15-2-1', $sandboxSid, 'S-1-1-0') -and $rule.AccessControlType -eq 'Deny') {
                $knownDenyMask = $knownDenyMask -bor $rights
            }
            # Do not export user/account SIDs or account names in diagnostic summaries.
            if ($sid -in @('S-1-15-2-1', $sandboxSid, 'S-1-1-0')) {
                $packageRules += [ordered]@{
                    sid = $sid
                    type = [string]$rule.AccessControlType
                    rights = [string]$rule.FileSystemRights
                    inherited = $rule.IsInherited
                    inheritanceFlags = [string]$rule.InheritanceFlags
                    inheritOnly = -not $applies
                }
            }
        }
        return [ordered]@{
            path = $RelativePath
            inheritanceProtected = $acl.AreAccessRulesProtected
            hasRequiredAllow = ($allowMask -band $requiredRights) -eq $requiredRights
            hasKnownReadExecuteDeny = ($knownDenyMask -band $requiredRights) -ne 0
            denyRuleCount = $denyCount
            rules = $packageRules
            error = $null
        }
    } catch {
        return [ordered]@{ path = $RelativePath; error = $_.Exception.Message }
    }
}

function Save-RepairReport {
    $json = $report | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($ReportPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

try {
    # A Node/Electron parent may inherit PowerShell 7's PSModulePath. Always load
    # Get-Acl from this Windows PowerShell 5.1 installation, not another edition.
    Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
    $root = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
    if ($root -eq [System.IO.Path]::GetPathRoot($root).TrimEnd('\', '/')) { throw 'A drive root is not an application directory.' }
    Assert-PlainPath $root
    if (-not (Get-Item -LiteralPath $root -Force).PSIsContainer) { throw 'InstallRoot must be a directory.' }
    $report.installRoot = $root
    $critical = @('.', 'AbandonNote.exe', 'icudtl.dat', 'resources', 'resources\app.asar', 'locales')
    if ($Mode -eq 'Inspect') {
        $report.checkedFiles = @($critical | ForEach-Object {
            Read-PermissionSummary (Join-Path $root $_) $_
        })
        $report.status = 'inspected'
        $report.Remove('backup')
        $report | ConvertTo-Json -Depth 12 -Compress
        exit 0
    }

    if (-not $ReportPath) { throw 'Repair requires a report path for the pre-change ACL backup.' }
    $ReportPath = [System.IO.Path]::GetFullPath($ReportPath)
    if ($ReportPath.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase) -or $ReportPath -eq $root) {
        throw 'The ACL backup must be outside the installation directory.'
    }
    if (Test-Path -LiteralPath $ReportPath) { Assert-PlainPath $ReportPath }
    else { Assert-PlainPath ([System.IO.Path]::GetDirectoryName($ReportPath)) }
    $canWriteReport = $true
    # Never follow links while granting inheritable rights or reading the backup.
    # Require the installed application layout before touching any ACL.
    foreach ($relative in $critical) {
        $path = Join-Path $root $relative
        Assert-PlainPath $path
        $isDirectory = (Get-Item -LiteralPath $path -Force).PSIsContainer
        if ($isDirectory -ne ($relative -in @('.', 'resources', 'locales'))) {
            throw "Unexpected application entry type: $relative"
        }
    }
    $entries = New-Object 'System.Collections.Generic.List[string]'
    $directories = New-Object 'System.Collections.Generic.Stack[string]'
    $entries.Add($root)
    $directories.Push($root)
    while ($directories.Count -gt 0) {
        foreach ($item in @(Get-ChildItem -LiteralPath ($directories.Pop()) -Force)) {
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Reparse point is not supported: $($item.FullName)"
            }
            $entries.Add($item.FullName)
            if ($item.PSIsContainer) { $directories.Push($item.FullName) }
        }
    }
    $backup = @()
    $before = @()
    foreach ($path in $entries) {
        $relative = if ($path -eq $root) { '.' } else { $path.Substring($root.Length + 1) }
        $acl = Get-Acl -LiteralPath $path
        $backup += [ordered]@{
            path = $relative
            dacl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
        }
        $before += Read-PermissionSummary $path $relative
    }
    $report.backup = $backup
    $report.checkedFiles = $before
    $report.status = 'backed-up'
    # Refuse to mutate if the complete pre-change backup cannot be persisted.
    Save-RepairReport
    foreach ($entry in $before) {
        if ($entry.error) { throw "$($entry.path): $($entry.error)" }
        if ($entry.hasKnownReadExecuteDeny) { throw "Read/execute is denied: $($entry.path)" }
        if ($entry.path -ne '.' -and $entry.inheritanceProtected -and -not $entry.hasRequiredAllow) {
            throw "Cannot inherit sandbox permissions: $($entry.path)"
        }
    }

    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    $output = & $icacls $root /grant '*S-1-15-2-2:(OI)(CI)(RX)' /Q 2>&1
    $result = $LASTEXITCODE
    $report.grantExitCode = $result
    $report.grantOutput = ($output | Out-String).Trim()
    if ($result -ne 0) { throw "icacls failed with exit code $result" }

    $after = @()
    foreach ($path in $entries) {
        $relative = if ($path -eq $root) { '.' } else { $path.Substring($root.Length + 1) }
        $after += Read-PermissionSummary $path $relative
    }
    $report.checkedFiles = $after
    foreach ($entry in $after) {
        if ($entry.error -or -not $entry.hasRequiredAllow -or $entry.hasKnownReadExecuteDeny) {
            throw "Sandbox permission verification failed: $($entry.path) $($entry.error)"
        }
    }
    $report.status = 'verified'
    Save-RepairReport
    Write-Output "Sandbox ACL policy verified for $($entries.Count) entries. Backup/report: $ReportPath"
    exit 0
} catch {
    $report.status = 'failed'
    $report.error = $_.Exception.Message
    if ($Mode -eq 'Repair' -and $canWriteReport) {
        try { Save-RepairReport } catch { [Console]::Error.WriteLine("Cannot write permission report: $($_.Exception.Message)") }
    }
    $report.Remove('backup')
    $report | ConvertTo-Json -Depth 12 -Compress
    exit 1
}
