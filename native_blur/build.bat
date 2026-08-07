@echo off
REM ============================================================
REM build.bat — 编译 blur_engine.dll
REM 
REM 前置条件：
REM   1. Visual Studio 2022（含"使用C++的桌面开发"工作负载）
REM   2. Windows 10 SDK (10.0.18362+)  
REM   3. CMake 3.20+（或使用下方 MSBuild 方式）
REM
REM 使用方式：
REM   在 Native Tools Command Prompt 中运行此脚本
REM   或：双击 build.bat（需提前配置好 VS 环境变量）
REM ============================================================

setlocal enabledelayedexpansion

echo ========================================
echo  Building blur_engine.dll
echo ========================================

REM 尝试激活 VS 环境
if not defined DevEnvDir (
    echo [INFO] 正在激活 Visual Studio 环境...
    call "%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" 2>nul
    if errorlevel 1 (
        call "%ProgramFiles%\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat" 2>nul
    )
    if errorlevel 1 (
        call "%ProgramFiles%\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat" 2>nul
    )
    if errorlevel 1 (
        echo [ERROR] 未找到 Visual Studio 2022。请安装 VS2022 并重试。
        exit /b 1
    )
)

REM 创建 build 目录
if not exist "build" mkdir "build"
cd build

REM ==== CMake 方式（推荐） ====
where cmake >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] 使用 CMake 构建...
    cmake .. -G "Visual Studio 17 2022" -A x64
    if errorlevel 1 (
        echo [ERROR] CMake 配置失败
        cd ..
        exit /b 1
    )
    cmake --build . --config Release
    if errorlevel 1 (
        echo [ERROR] 构建失败
        cd ..
        exit /b 1
    )
    echo [OK] DLL 已生成: build\bin\Release\blur_engine.dll
    cd ..
    exit /b 0
)

REM ==== 回退：MSBuild 方式 ====
echo [INFO] CMake 未找到，使用 MSBuild...

REM 生成 .cpp 文件列表（作为 cl.exe 输入）
set "SOURCES=..\blur_engine.cpp ..\blur_api.cpp ..\window_motion_edge_monitor.cpp"

REM 编译为 DLL
cl.exe /std:c++17 /EHsc /O2 /MT ^
    /D BLUR_DLL_EXPORTS ^
    /D WIN32_LEAN_AND_MEAN ^
    /D NOMINMAX ^
    /D _WIN32_WINNT=0x0A00 ^
    /I "%WindowsSdkDir%Include\%WindowsSDKVersion%cppwinrt" ^
    %SOURCES% ^
    /Fe:blur_engine.dll ^
    /link ^
    dwmapi.lib user32.lib gdi32.lib ^
    WindowsApp.lib ^
    /DLL /SUBSYSTEM:WINDOWS

if errorlevel 1 (
    echo [ERROR] 编译失败。请确保在 VS 开发者命令行中运行。
    cd ..
    exit /b 1
)

echo [OK] DLL 已生成: build\blur_engine.dll
cd ..
exit /b 0
