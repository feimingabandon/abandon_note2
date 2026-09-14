// Electron show 可能仍在 Win32 显示消息栈内；退出该栈后再同步等待 STA 配置。
// 合并同一窗口的重复 show，并在执行前检查窗口是否仍然有效、可见及当前活跃。
export function createDeferredWindowRestore({ canRestore, restore, schedule = setImmediate }) {
  const pending = new WeakSet()
  return (window, source) => {
    if (!window || pending.has(window)) return
    pending.add(window)
    schedule(() => {
      pending.delete(window)
      if (canRestore(window)) restore(window, source)
    })
  }
}
