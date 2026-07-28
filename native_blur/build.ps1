# Build blur_engine.dll with the Visual Studio generator available on this machine.
[CmdletBinding()]
param(
    [ValidateSet("x64")]
    [string]$Architecture = "x64",
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$sourceDirectory = $PSScriptRoot
$buildDirectory = Join-Path $sourceDirectory "build"
$outputDll = Join-Path $buildDirectory "bin\blur_engine.dll"

$cmakeCommand = Get-Command cmake -ErrorAction SilentlyContinue
$cmakeExecutable = if ($cmakeCommand) { $cmakeCommand.Source } else { $null }

if (-not $cmakeExecutable) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
        $visualStudioDirectory = & $vswhere -latest -products * `
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
            -property installationPath
        if ($visualStudioDirectory) {
            $bundledCmake = Join-Path $visualStudioDirectory `
                "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
            if (Test-Path -LiteralPath $bundledCmake -PathType Leaf) {
                $cmakeExecutable = $bundledCmake
            }
        }
    }
}

if (-not $cmakeExecutable) {
    throw "CMake 3.20 or newer is required."
}

Write-Host "=== Configure blur_engine ($Architecture / $Configuration) ===" -ForegroundColor Green
& $cmakeExecutable -S $sourceDirectory -B $buildDirectory -A $Architecture
if ($LASTEXITCODE -ne 0) {
    throw "CMake configure failed with exit code $LASTEXITCODE."
}

Write-Host "=== Build blur_engine ===" -ForegroundColor Green
& $cmakeExecutable --build $buildDirectory --config $Configuration
if ($LASTEXITCODE -ne 0) {
    throw "CMake build failed with exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $outputDll -PathType Leaf)) {
    throw "Build completed but the DLL was not found: $outputDll"
}

Write-Host "=== Build succeeded: $outputDll ===" -ForegroundColor Green
