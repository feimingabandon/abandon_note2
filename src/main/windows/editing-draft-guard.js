/** All destructive main-view lifecycle paths share this negotiation. */
export function createEditingDraftGuard({ dialog, logger }) {
  let pending = null
  return (window, action) => {
    if (pending) return pending
    pending = (async () => {
      if (!window || window.isDestroyed() || window.webContents.isCrashed()) return true
      let timer
      try {
        const state = await Promise.race([
          window.webContents.executeJavaScript(
            'window.__prepareEditingDrafts?.() ?? { dirty: false, blocked: false }'
          ),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('草稿检查超时')), 3000)
          })
        ])
        if (state.blocked) {
          await dialog.showMessageBox(window, {
            type: 'warning',
            message: '请先完成保存，再' + action,
            detail: '正在提交内容，或草稿暂存失败。当前窗口将保持打开。',
            buttons: ['返回编辑']
          })
          return false
        }
        if (!state.dirty) return true
        const { response } = await dialog.showMessageBox(window, {
          type: 'question',
          message: '有尚未保存的编辑内容',
          detail: '草稿已在本机暂存。继续后，重新打开对应编辑器即可恢复；也可以在设置中导出草稿。',
          buttons: ['返回编辑', '保留草稿并' + action],
          defaultId: 0,
          cancelId: 0
        })
        return response === 1
      } catch (error) {
        logger.error('editing-draft.guard', error)
        await dialog.showMessageBox(window, {
          type: 'warning',
          message: '暂时无法确认编辑内容已安全保存',
          detail: '本次操作已取消，请返回窗口保存内容后重试。',
          buttons: ['返回']
        })
        return false
      } finally {
        clearTimeout(timer)
      }
    })().finally(() => {
      pending = null
    })
    return pending
  }
}
