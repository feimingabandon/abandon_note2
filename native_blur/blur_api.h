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

// ---- 生命周期 ----
BLUR_API int  Blur_Init(void* hwnd);
BLUR_API void Blur_Destroy(void);

// ---- 参数 ----
// 推荐入口：一次跨 FFI 调用完整更新，STA 线程只处理一次配置消息。
BLUR_API void Blur_ApplyConfig(int enabled, float radiusDip, float saturation, float cornerRadiusDip);
BLUR_API void Blur_SetRadius(float radiusDip);        // 模糊半径 0~40
BLUR_API void Blur_SetSaturation(float saturation);    // 饱和度 0~2
BLUR_API void Blur_SetCornerRadius(float radiusDip);  // 圆角 0~30
BLUR_API void Blur_SetEnabled(int enabled);            // 开关 0/1

// 旧版 ABI 兼容：玻璃颜色/通透度已改由 Electron CSS 背景层负责，这两个调用不再改变画面。
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

// ---- Windows 窗口物理移动（无回调、绝不修改宽高）----
BLUR_API int WindowMotion_MoveWindow(void* hwnd, int physicalX, int physicalY);
BLUR_API const char* WindowMotion_GetSnapshotJson(void* hwnd);
BLUR_API int WindowMotion_IsEdgeExposed(void* hwnd, int side);

#ifdef __cplusplus
}
#endif
