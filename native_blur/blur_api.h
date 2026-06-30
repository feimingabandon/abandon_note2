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

// ---- 参数（2 个可控维度） ----
BLUR_API void Blur_SetRadius(float radiusDip);       // 模糊半径 0~100
BLUR_API void Blur_SetTint(int r, int g, int b);      // 颜色 RGB 0~255
BLUR_API void Blur_SetSaturation(float saturation);    // 饱和度 0~2
BLUR_API void Blur_SetCornerRadius(float radiusDip);  // 圆角 0~30
BLUR_API void Blur_SetEnabled(int enabled);            // 开关 0/1

// ---- 位置同步 ----
BLUR_API void Blur_UpdateGeometry(int x, int y, int width, int height);

// ---- 查询 ----
BLUR_API int Blur_IsInitialized(void);
BLUR_API int Blur_IsSupported(void);

#ifdef __cplusplus
}
#endif
