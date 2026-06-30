# build.ps1 — VS 2026 环境编译 blur_engine.dll
$ErrorActionPreference = "Stop"

$vsDir = "C:\Program Files\Microsoft Visual Studio\18\Community"
$vcvars = "$vsDir\VC\Auxiliary\Build\vcvarsall.bat"
$srcDir = "C:\addFile\idea\项目\abandon\abandon_note2\native_blur"
$buildDir = "$srcDir\build"

# 清理旧构建
if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

# 用 cmd 链接: vcvars 设置环境 → cmake 配置 → msbuild 编译
$cmd = "call `"$vcvars`" x64 && cd /d `"$buildDir`" && cmake .. -G `"Visual Studio 18 2026`" -A x64 && cmake --build . --config Release"

Write-Host "=== 开始编译 ===" -ForegroundColor Green
cmd /c $cmd

# 检查结果
$dll = Get-ChildItem -Path $buildDir -Recurse -Filter "blur_engine.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($dll) {
    Write-Host "=== 编译成功! ===" -ForegroundColor Green
    Write-Host $dll.FullName
} else {
    Write-Host "=== DLL 未生成，检查上方错误信息 ===" -ForegroundColor Red
}
