/**
 * Windows 原生组件与主进程桥接层共享的 ABI 版本。
 *
 * native_blur 的任何导出或运行语义发生变化时都必须递增；应用启动和打包校验
 * 都要求 DLL 精确匹配该版本，不允许缺失组件或旧 DLL 静默降级运行。
 */
export const NATIVE_ABI_VERSION = 1
