import { ipcRenderer } from 'electron'

// setIgnoreMouseEvents({ forward: true }) 明确转发的是鼠标移动消息。直接监听
// mousemove 比依赖 DOM 的 mouseenter 状态转换更可靠，也不受 body 实际布局尺寸影响。
let reported = false
window.addEventListener(
  'mousemove',
  () => {
    if (reported) return
    reported = true
    ipcRenderer.send('logs:write', {
      level: 'info',
      scope: 'dock.trigger.mousemove',
      message: '边缘触发窗口收到 mousemove'
    })
    ipcRenderer.send('trigger-enter')
  },
  { capture: true, passive: true }
)
