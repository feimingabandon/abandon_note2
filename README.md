方案 1（最常用）
Renderer DOM 监听

例如：

Renderer：渲染器：

window.addEventListener('mouseenter', () => {
  window.api.windowHover(true)
})

window.addEventListener('mouseleave', () => {
  window.api.windowHover(false)
})

然后：

IPC 给主进程。

这是最推荐的

因为：

最稳定
Chromium 已处理边界
不需要主进程算坐标
不怕透明区域
不怕 DPI