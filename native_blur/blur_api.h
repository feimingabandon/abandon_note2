/**
 * blur_api.h — C 语言导出接口（供 koffi FFI 调用）
 */

#pragma once

#ifdef BLUR_DLL_EXPORTS
#define BLUR_API __declspec(dllexport)
#else
#define BLUR_API __declspec(dllimport)
#endif

#ifdef __cplusplus
extern "C" {
#endif

// ---- 应用 / DLL ABI 硬门槛 ----
// 任何导出或运行语义变化都必须递增；主进程只接受精确匹配的版本。
BLUR_API int AbandonNative_GetAbiVersion(void);

// ---- 生命周期 ----
BLUR_API int  Blur_Init(void* hwnd);
BLUR_API void Blur_Destroy(void);

// ---- 参数 ----
// 推荐入口：一次跨 FFI 调用完整更新，并在 STA/DWM 完成材质切换后返回。
// 返回 1 表示 Renderer 可以安全切换 CSS 回退底色，0 表示配置未完成。
BLUR_API int Blur_ApplyConfig(
    int enabled,
    float radiusDip,
    float saturation,
    float cornerRadiusDip,
    int tintR,
    int tintG,
    int tintB,
    float tintOpacity);
BLUR_API void Blur_SetRadius(float radiusDip);        // 模糊半径 0~40
BLUR_API void Blur_SetSaturation(float saturation);    // 饱和度 0~2
BLUR_API void Blur_SetCornerRadius(float radiusDip);  // 圆角 0~30
BLUR_API void Blur_SetEnabled(int enabled);            // 开关 0/1

// 兼容独立调节入口；主应用优先使用 Blur_ApplyConfig 原子更新完整材质。
BLUR_API void Blur_SetTint(int r, int g, int b);
BLUR_API void Blur_SetOpacity(float opacity);

// ---- 位置同步 ----
BLUR_API void Blur_UpdateGeometry(void);

// ---- Z-order 重同步 ----
BLUR_API void Blur_ReSyncOrder(void);

// ---- 查询 ----
BLUR_API int Blur_IsInitialized(void);
BLUR_API int Blur_IsHealthy(void);
BLUR_API int Blur_IsZOrderSynchronized(void);
BLUR_API int Blur_IsSupported(void);
BLUR_API int Blur_GetLastErrorCode(void);
BLUR_API const char* Blur_GetLastErrorMessage(void);
BLUR_API const char* Blur_GetLastFailureJson(void);

// ---- Windows 窗口物理移动（无回调、绝不修改宽高）----
BLUR_API int WindowMotion_MoveWindow(void* hwnd, int physicalX, int physicalY);
BLUR_API const char* WindowMotion_GetSnapshotJson(void* hwnd);
// side: -1=left, 1=right, -2=top, 2=bottom
BLUR_API int WindowMotion_IsEdgeExposed(void* hwnd, int side);
// Windows 原生边缘监视器：只在贴边隐藏期间每 pollIntervalMs 读取一次光标位置；
// 同一显示器被其他进程真正全屏覆盖时抑制触发，普通最大化窗口不受影响。
BLUR_API int WindowMotion_ArmEdgeMonitor(
    void* hwnd,
    int side,
    int thicknessDip,
    int pollIntervalMs,
    unsigned long long generation);
// revealMode: 0=触边立即通知；1=触边显示确认条；2=由主进程在隐藏完成后激活常显确认条。
// WindowMotion_ArmEdgeMonitor 是当前 ABI 的直接唤出入口。
BLUR_API int WindowMotion_ArmEdgeMonitorEx(
    void* hwnd,
    int side,
    int thicknessDip,
    int pollIntervalMs,
    unsigned long long generation,
    int revealMode);
BLUR_API int WindowMotion_DisarmEdgeMonitor(unsigned long long generation);
// positionPermille: -1=沿用窗口边缘中点；0~1000=当前显示器工作区上的归一化位置。
BLUR_API int WindowMotion_SetPersistentHandlePosition(
    unsigned long long generation,
    int positionPermille);
BLUR_API int WindowMotion_ShowPersistentHandle(unsigned long long generation);
BLUR_API unsigned int WindowMotion_GetEdgeMessageId(void);
BLUR_API const char* WindowMotion_GetEdgeMonitorStatusJson(void);
BLUR_API const char* WindowMotion_ConsumeEdgeEventJson(void);

// ---- Windows 主窗口始终置底 ----
// 返回值：1=成功；负数为参数、线程、Subclass、WinEvent Hook 或应用失败。
BLUR_API int WindowZOrder_SetBottom(void* hwnd, int enabled);
BLUR_API int WindowZOrder_Reassert(void* hwnd);
BLUR_API const char* WindowZOrder_GetStatusJson(void* hwnd);

#ifdef __cplusplus
}
#endif
