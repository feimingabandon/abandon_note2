cmake_minimum_required(VERSION 3.20)
project(blur_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 必须使用 MSVC（WinRT / C++/WinRT）
if(NOT MSVC)
    message(FATAL_ERROR "此项目仅支持 MSVC 编译器（需要 C++/WinRT 支持）")
endif()

# 将 MSVC C/C++ 运行库静态链接进 blur_engine.dll，避免发布后的应用
# 依赖用户电脑预装 MSVCP140/VCRUNTIME140 系列 DLL。
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# C++/WinRT 配置
# 使用系统安装的 Windows SDK 中的 C++/WinRT
# 无需 NuGet 包 — C++/WinRT 已内置于 Windows SDK 10.0.17763+

# 源文件
set(SOURCES
    blur_engine.cpp
    blur_api.cpp
    window_motion_edge_monitor.cpp
    reveal_handle_renderer.cpp
    reveal_handle_resources.rc
)

set(HEADERS
    blur_engine.h
    blur_api.h
    blur_effects.h
    window_motion_edge_monitor.h
    reveal_handle_renderer.h
    reveal_handle_resource.h
)

# 生成 DLL
add_library(blur_engine SHARED ${SOURCES} ${HEADERS})

# 预处理器定义
target_compile_definitions(blur_engine PRIVATE
    BLUR_DLL_EXPORTS
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _WIN32_WINNT=0x0A00  # Windows 10+
    _SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS
)

# 链接库
target_link_libraries(blur_engine PRIVATE
    d2d1
    dwrite
    windowscodecs
    ole32
    dxguid
    dwmapi
    user32
    gdi32
    WindowsApp   # Windows Runtime (UWP) umbrella library
)

# 编译器选项
target_compile_options(blur_engine PRIVATE
    /W3          # 警告级别 3
    /utf-8       # UTF-8 源文件
    /permissive- # 标准一致性
)

# 输出目录
set_target_properties(blur_engine PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib"
)

# 后构建步骤：将 DLL 复制到 Electron 项目目录
# 注：可根据实际需要调整目标路径
add_custom_command(TARGET blur_engine POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E echo "DLL built: $<TARGET_FILE:blur_engine>"
)
