import assert from 'node:assert/strict'

/** Exercise native keyboard events against a DatePicker inside its real modal. */
export async function verifyDatePickerKeyboard(window, triggerSelector, modalSelector) {
  const js = (code) => window.webContents.executeJavaScript(code, true)
  const trigger = `document.querySelector(${JSON.stringify(triggerSelector)})`
  async function until(code, message) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await js(code)) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const state = await js(
      `({focus:document.activeElement?.outerHTML?.slice(0,800),picker:document.querySelector('.date-picker-panel')?.outerHTML?.slice(0,1600)})`
    )
    throw new Error(`${message}: ${JSON.stringify(state)}`)
  }
  async function key(keyCode, modifiers = []) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode === 'Return') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  async function open() {
    await js(`${trigger}.focus()`)
    await key('Return')
    await until(
      `document.activeElement?.matches('.date-picker-panel__day.is-selected')`,
      '日期面板打开后未聚焦所选日期'
    )
  }
  async function closed() {
    await until('!document.querySelector(".date-picker-panel")', '日期浮层未关闭')
    assert.equal(
      await js(`Boolean(document.querySelector(${JSON.stringify(modalSelector)}))`),
      true,
      '关闭日期浮层不应关闭外层弹窗'
    )
    assert.equal(await js(`document.activeElement === ${trigger}`), true, '关闭后未恢复触发器焦点')
  }

  // The modal schedules its initial focus on the next frame; let it settle before typing.
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await until(
    `!document.querySelector(${JSON.stringify(modalSelector)}).closest('.app-modal-card').getAnimations().some(animation => animation.playState === 'running')`,
    '外层弹窗尚未完成入场'
  )
  await open()
  await key('Tab')
  assert.equal(
    await js("Boolean(document.activeElement.closest('.date-picker-panel'))"),
    true,
    'Tab 应能遍历日期面板控件'
  )
  await js("document.querySelector('.date-picker-panel button:not(:disabled)').focus()")
  await key('Tab', ['shift'])
  assert.equal(
    await js("document.activeElement.matches('.date-picker-panel__footer button')"),
    true,
    'Shift+Tab 应从第一个控件回到面板末尾'
  )
  await key('Tab')
  assert.equal(
    await js(
      "document.activeElement === document.querySelector('.date-picker-panel button:not(:disabled)')"
    ),
    true,
    'Tab 应从面板末尾回到第一个控件'
  )
  await key('Escape')
  await closed()

  await open()
  await js(`${trigger}.focus()`)
  await key('Escape')
  await closed()

  await open()
  await key('Return')
  await closed()
}
