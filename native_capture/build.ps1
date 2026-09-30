[CmdletBinding()]
param([string]$QtRoot = '', [switch]$Test)
$ErrorActionPreference = 'Stop'
if (!$QtRoot) { $QtRoot = $env:QT_ROOT_DIR }
if (!$QtRoot) { $QtRoot = Join-Path $PSScriptRoot '../tmp/toolchains/qt/6.8.3/msvc2022_64' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$cmake = Join-Path $vs 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
if (!(Test-Path "$QtRoot/lib/cmake/Qt6/Qt6Config.cmake")) { throw 'Qt 6.8.3 MSVC2022 x64 required; see native_capture/README.md' }
$build = Join-Path $PSScriptRoot 'build'
& $cmake -S $PSScriptRoot -B $build -A x64 "-DCMAKE_PREFIX_PATH=$QtRoot"
if ($LASTEXITCODE -ne 0) { throw 'Capture configure failed' }
& $cmake --build $build --config Release --parallel
if ($LASTEXITCODE -ne 0) { throw 'Capture build failed' }
$env:PATH = "$QtRoot/bin;$env:PATH"
$env:VCINSTALLDIR = Join-Path $vs 'VC'
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
if ($Test) {
    & (Join-Path (Split-Path $cmake) 'ctest.exe') --test-dir $build -C Release --output-on-failure
    if ($LASTEXITCODE -ne 0) { throw 'Capture native tests failed' }
}
