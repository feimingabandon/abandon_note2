[CmdletBinding()]
param(
    [string]$QtRoot = '',
    [switch]$Test,
    [string[]]$TestName = @(),
    [switch]$TestsOnly,
    [switch]$BuildOnly,
    [switch]$InputDriver,
    [string]$BuildDirectory = '',
    [string]$ResultDirectory = ''
)
$ErrorActionPreference = 'Stop'
$knownTests = @('capture_core', 'capture_ui', 'capture_ux', 'capture_selection', 'capture_pin_halo', 'capture_polish', 'capture_clipboard')
$selectedTests = @($TestName | ForEach-Object { $_ -split ',' })
if ($Test -and $selectedTests.Count -eq 0) { throw '-Test requires explicit -TestName; no default full suite is available' }
if (!$Test -and $selectedTests.Count -gt 0) { throw '-TestName requires -Test' }
if ($TestsOnly -and !$Test) { throw '-TestsOnly requires -Test and explicit -TestName' }
if ($Test -and !$BuildOnly -and !$ResultDirectory) { throw 'Test execution requires -ResultDirectory for the current attempt' }
if (@($selectedTests | Select-Object -Unique).Count -ne $selectedTests.Count) { throw 'Duplicate Capture test names are not allowed' }
foreach ($name in $selectedTests) {
    if ($knownTests -cnotcontains $name) { throw "Unknown Capture test name: $name" }
}

$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
function Resolve-WorkspaceDirectory([string]$Value) {
    if ($Value.IndexOfAny([char[]]",;`r`n") -ge 0) { throw 'Build/result directories cannot contain commas, semicolons or newlines' }
    $resolved = [IO.Path]::GetFullPath($Value)
    if (!$resolved.StartsWith($workspaceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Build/result directories must remain inside the repository workspace'
    }
    $ancestor = $resolved
    while ($ancestor -and $ancestor.Length -ge $workspaceRoot.Length) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if (!$item.PSIsContainer) { throw "Build/result path is not a directory: $ancestor" }
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Build/result directory cannot traverse a reparse point: $ancestor" }
        }
        $ancestor = Split-Path -Parent $ancestor
    }
    return $resolved
}
if (!$BuildDirectory) { $BuildDirectory = Join-Path $PSScriptRoot 'build' }
$build = Resolve-WorkspaceDirectory $BuildDirectory
if (!$ResultDirectory) { $ResultDirectory = Join-Path $build 'test-results' }
$results = Resolve-WorkspaceDirectory $ResultDirectory
if ($Test -and !$BuildOnly) {
    foreach ($file in @('ctest-selection.json', 'ctest-results.xml') + @($selectedTests | ForEach-Object { "$_.junit.xml"; "$_.txt" })) {
        if (Test-Path -LiteralPath (Join-Path $results $file)) { throw "Current attempt requires new result files; already present: $file" }
    }
}

if (!$QtRoot) { $QtRoot = $env:QT_ROOT_DIR }
if (!$QtRoot) { $QtRoot = Join-Path $PSScriptRoot '../tmp/toolchains/qt/6.8.3/msvc2022_64' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$cmake = Join-Path $vs 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
if (!(Test-Path "$QtRoot/lib/cmake/Qt6/Qt6Config.cmake")) { throw 'Qt 6.8.3 MSVC2022 x64 required; see native_capture/README.md' }
$testsFlag = if ($Test) { 'ON' } else { 'OFF' }
$driverFlag = if ($InputDriver) { 'ON' } else { 'OFF' }
& $cmake -S $PSScriptRoot -B $build -A x64 "-DCMAKE_PREFIX_PATH=$QtRoot" "-DABANDON_CAPTURE_BUILD_TESTS=$testsFlag" "-DABANDON_CAPTURE_TEST_NAMES=$($selectedTests -join ';')" "-DABANDON_CAPTURE_BUILD_INPUT_DRIVER=$driverFlag" "-DABANDON_CAPTURE_RESULT_DIRECTORY=$results"
if ($LASTEXITCODE -ne 0) { throw 'Capture configure failed' }
$targets = @()
if (!$TestsOnly) { $targets += @('AbandonCapture', 'capture_host') }
$targets += @($selectedTests | ForEach-Object { "${_}_tests" })
if ($InputDriver) { $targets += 'capture_input_driver' }
& $cmake --build $build --config Release --parallel --target @targets
if ($LASTEXITCODE -ne 0) { throw 'Capture build failed' }
$env:PATH = "$QtRoot/bin;$env:PATH"
$env:VCINSTALLDIR = Join-Path $vs 'VC'
if (!$TestsOnly) {
    $deploy = Join-Path $PSScriptRoot 'deploy'
    New-Item -ItemType Directory -Force -Path $deploy | Out-Null
    Copy-Item -LiteralPath "$build/bin/AbandonCapture.exe", "$build/bin/capture_host.dll" -Destination $deploy -Force
    & "$QtRoot/bin/windeployqt.exe" --release --no-translations --no-opengl-sw --no-system-d3d-compiler --no-quick-import --no-compiler-runtime --dir $deploy "$deploy/AbandonCapture.exe"
    if ($LASTEXITCODE -ne 0) { throw 'Qt deployment failed' }
    if (Test-Path -LiteralPath "$deploy/vc_redist.x64.exe") { Remove-Item -LiteralPath "$deploy/vc_redist.x64.exe" }
    $redist = Get-ChildItem (Join-Path $vs 'VC/Redist/MSVC') -Directory | Where-Object { $_.Name -match '^14\.' } | Sort-Object Name -Descending | Select-Object -First 1
    $crt = Get-ChildItem (Join-Path $redist.FullName 'x64') -Directory -Filter '*.CRT' | Select-Object -First 1
    if (!$crt) { throw 'MSVC app-local runtime was not found' }
    Copy-Item -Path (Join-Path $crt.FullName '*.dll') -Destination $deploy -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../LICENSE'), (Join-Path $PSScriptRoot 'THIRD_PARTY.md') -Destination $deploy -Force
}
if ($Test -and !$BuildOnly) {
    New-Item -ItemType Directory -Force -Path $results | Out-Null
    $ctest = Join-Path (Split-Path $cmake) 'ctest.exe'
    $pattern = '^(' + (($selectedTests | ForEach-Object { [Regex]::Escape($_) }) -join '|') + ')$'
    $selectionJson = (& $ctest --test-dir $build -C Release --show-only=json-v1 -R $pattern) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Capture CTest selection failed' }
    $selection = $selectionJson | ConvertFrom-Json
    $discoveredNames = @($selection.tests | ForEach-Object { $_.name })
    if ($discoveredNames.Count -ne $selectedTests.Count -or @($discoveredNames | Where-Object { $selectedTests -cnotcontains $_ }).Count -gt 0) {
        throw 'CTest selection does not exactly match the requested Capture tests'
    }
    $selectionJson | Set-Content -LiteralPath (Join-Path $results 'ctest-selection.json') -Encoding UTF8
    & $ctest --test-dir $build -C Release -R $pattern --no-tests=error --output-on-failure --output-junit (Join-Path $results 'ctest-results.xml')
    $ctestExitCode = $LASTEXITCODE
    $ctestReport = Join-Path $results 'ctest-results.xml'
    if (!(Test-Path -LiteralPath $ctestReport)) { throw 'CTest did not produce the current attempt report' }
    [xml]$report = Get-Content -LiteralPath $ctestReport -Raw
    $cases = @($report.SelectNodes('/testsuite/testcase'))
    if ($cases.Count -ne $selectedTests.Count -or @($cases | Where-Object { $selectedTests -cnotcontains $_.name }).Count -gt 0) {
        throw 'CTest result names do not exactly match the requested Capture tests'
    }
    foreach ($case in $cases) {
        if ($case.status -ne 'run' -or $case.SelectSingleNode('skipped')) { throw "CTest did not run the requested test: $($case.name)" }
    }
    foreach ($name in $selectedTests) {
        $qtestReport = Join-Path $results "$name.junit.xml"
        $qtestText = Join-Path $results "$name.txt"
        if (!(Test-Path -LiteralPath $qtestReport) -or !(Test-Path -LiteralPath $qtestText)) { throw "QTest did not produce fresh reports for $name" }
        [xml]$qtest = Get-Content -LiteralPath $qtestReport -Raw
        $actualCases = @($qtest.SelectNodes('//testcase') | Where-Object { $_.name -notmatch '^(initTestCase|cleanupTestCase)(\(|$)' })
        $runCases = @($actualCases | Where-Object { !$_.SelectSingleNode('skipped') })
        if ($runCases.Count -eq 0) { throw "QTest contains no executed business cases for $name" }
        if ($qtest.SelectNodes('//failure | //error').Count -gt 0) { throw "QTest reported failures for $name" }
    }
    if ($ctestExitCode -ne 0) { throw "Capture native tests failed (CTest exit $ctestExitCode)" }
}
