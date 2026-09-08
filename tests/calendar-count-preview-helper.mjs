import assert from 'node:assert/strict'

export async function verifyCalendarCountPreview(window, waitUntil) {
  const originalBounds = window.getBounds()
  const isWeek = await window.webContents.executeJavaScript(
    `document.querySelector('.month-grid').getAttribute('aria-label') === '周历'`
  )
  const total = isWeek ? 10 : 3
  window.setSize(720, 900)
  await waitUntil(() => window.getBounds().height === 900, '数量标记测试未进入大窗口')
  const key = await window.webContents.executeJavaScript(`(() => {
    const cell = Array.from(document.querySelectorAll('.month-day-cell')).find((item) =>
      !item.querySelector('.month-day-cell__count') && !item.classList.contains('is-today'))
    return cell?.dataset.date
  })()`)
  assert.ok(key, '数量标记测试缺少空白日期')
  const ids = await window.webContents.executeJavaScript(`(async () => {
    const ids = []
    for (let index = 0; index < ${total}; index += 1) {
      const note = await window.api.createNote({
        content: '数量预览专项-' + index,
        effectiveAt: new Date('${key}T00:01:00').getTime(),
        durationDays: 1
      })
      ids.push(note.id)
    }
    return ids
  })()`)
  const badgeSelector = `.month-day-cell[data-date="${key}"] .month-day-cell__count`
  const readBadge = () =>
    window.webContents.executeJavaScript(`(() => {
    const badge = document.querySelector('${badgeSelector}')
    if (!badge) return null
    const style = getComputedStyle(badge)
    return { tag: badge.tagName, text: badge.textContent.trim(), overflow: badge.classList.contains('is-overflow'),
      title: badge.title, color: style.color, background: style.backgroundColor }
  })()`)
  const normal = await waitUntil(async () => {
    const badge = await readBadge()
    return badge?.text === String(total) && !badge.overflow ? badge : null
  }, '所有便签显示后数量标记未恢复普通状态')
  assert.equal(normal.tag, 'SPAN')
  window.setSize(720, 280)
  const overflow = await waitUntil(async () => {
    const badge = await readBadge()
    return badge?.overflow ? badge : null
  }, '缩小窗口后未突出存在隐藏便签的数量标记')
  assert.equal(overflow.tag, 'BUTTON')
  assert.equal(overflow.text, String(total))
  assert.match(overflow.title, /已显示 \d+ 条，点击预览全部/)
  assert.notEqual(overflow.color, normal.color)
  assert.notEqual(overflow.background, normal.background)
  assert.equal(overflow.color, 'rgb(255, 255, 255)', '溢出数量必须使用白字')
  assert.equal(overflow.background, 'rgb(10, 132, 255)', '溢出数量必须使用实心强调蓝底')
  const alignment = await window.webContents.executeJavaScript(`(() => {
    const badge = document.querySelector('${badgeSelector}')
    const label = badge.querySelector('.month-day-cell__count-label').getBoundingClientRect()
    const rect = badge.getBoundingClientRect()
    const plus = badge.parentElement.querySelector('.month-day-cell__quick-create').getBoundingClientRect()
    return { x: Math.abs(label.left + label.width / 2 - rect.left - rect.width / 2),
      y: Math.abs(label.top + label.height / 2 - rect.top - rect.height / 2),
      footer: Math.abs(rect.top + rect.height / 2 - plus.top - plus.height / 2) }
  })()`)
  assert.ok(alignment.x < 0.75 && alignment.y < 0.75, '数量文字未在按钮内水平垂直居中')
  assert.ok(alignment.footer < 0.75, '数量标记与左侧加号未垂直对齐')
  await window.webContents.executeJavaScript(`(() => {
    window.__countPreviewAnimations = []
    const original = Element.prototype.animate
    window.__countPreviewOriginalAnimate = original
    Element.prototype.animate = function(frames, options) {
      if (this.classList.contains('month-day-preview')) window.__countPreviewAnimations.push({ frames, options })
      return original.call(this, frames, options)
    }
  })()`)
  const point = await window.webContents.executeJavaScript(`(() => {
    const badge = document.querySelector('${badgeSelector}')
    const rect = badge.getBoundingClientRect()
    const x = Math.floor(rect.left + rect.width / 2)
    const y = Math.floor(rect.top + rect.height / 2)
    return { x, y, hit: document.elementFromPoint(x, y) === badge }
  })()`)
  assert.ok(point.hit, '数量按钮被快速新建热区或其他图层遮挡')
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(`(() => {
      const preview = document.querySelector('.month-day-preview')
      return preview?.getAttribute('aria-label') === '${key} 全部便签预览' &&
        preview.querySelectorAll('.month-day-preview__note').length === ${total}
    })()`),
    '点击数量未打开当天全部便签预览'
  )
  assert.deepEqual(
    await window.webContents.executeJavaScript(`({
    selected: document.querySelector('.month-day-cell.is-selected')?.dataset.date,
    quickCreate: Boolean(document.querySelector('.month-day-cell__quick-create input')),
    sidePanel: Boolean(document.querySelector('.month-day-panel')),
    expanded: document.querySelector('${badgeSelector}').getAttribute('aria-expanded')
  })`),
    { selected: key, quickCreate: false, sidePanel: false, expanded: 'true' }
  )
  const opening = await window.webContents.executeJavaScript(`window.__countPreviewAnimations[0]`)
  assert.equal(opening.frames[0].clipPath, 'inset(0 100% 0 0 round 12px)', '右侧预览必须向右卷帘')
  assert.equal(opening.frames[1].clipPath, 'inset(0 0 0 0 round 12px)')
  assert.ok(
    opening.frames.every((frame) => !frame.transform),
    '卷帘不能拉伸文字或缩放整个面板'
  )
  const clickCount = () => {
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1
    })
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1
    })
  }
  clickCount()
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `!document.querySelector('.month-day-preview') && document.querySelector('${badgeSelector}').getAttribute('aria-expanded') === 'false'`
      ),
    '再次点击同一数量按钮没有关闭预览'
  )
  const closing = await window.webContents.executeJavaScript(
    `window.__countPreviewAnimations.at(-1)`
  )
  assert.equal(
    closing.frames.at(-1).clipPath,
    'inset(0 100% 0 0 round 12px)',
    '收起必须沿展开方向反向卷回'
  )
  clickCount()
  await new Promise((resolve) => setTimeout(resolve, 45))
  clickCount()
  await new Promise((resolve) => setTimeout(resolve, 45))
  clickCount()
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(`(() => {
      const preview = document.querySelector('.month-day-preview')
      return document.querySelectorAll('.month-day-preview').length === 1 &&
        document.querySelector('${badgeSelector}').getAttribute('aria-expanded') === 'true' &&
        !preview.getAnimations().some((animation) => animation.playState === 'running') &&
        getComputedStyle(preview).clipPath.slice(6).split(' round ')[0].trim().split(' ').every((value) => parseFloat(value) === 0)
    })()`),
    '快速开关后预览没有稳定到单个完整展开的面板'
  ).catch(async (error) => {
    console.error(
      await window.webContents.executeJavaScript(`(() => {
      const preview = document.querySelector('.month-day-preview')
      return { count: document.querySelectorAll('.month-day-preview').length,
        expanded: document.querySelector('${badgeSelector}').getAttribute('aria-expanded'),
        clip: preview && getComputedStyle(preview).clipPath,
        animations: preview?.getAnimations().map((item) => ({ state: item.playState, frames: item.effect.getKeyframes() })) }
    })()`)
    )
    throw error
  })
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `!document.querySelector('.month-day-preview') && document.activeElement === document.querySelector('${badgeSelector}')`
      ),
    '关闭数量预览后焦点未回到数量按钮'
  )
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(`Boolean(document.querySelector('.month-day-preview'))`),
    '数量按钮不支持键盘打开预览'
  )
  window.setSize(720, 900)
  await waitUntil(async () => {
    const badge = await readBadge()
    return badge?.tag === 'SPAN' && !badge.overflow
  }, '放大窗口后数量仍错误提示有便签未显示')
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `!document.querySelector('.month-day-preview') && document.activeElement?.matches('.month-day-cell[data-date="${key}"]')`
      ),
    '数量按钮消失后关闭预览未回退到日期格焦点'
  )
  const normalPoint = await window.webContents.executeJavaScript(`(() => {
    const badge = document.querySelector('${badgeSelector}')
    const rect = badge.getBoundingClientRect()
    return { x: Math.floor(rect.left + rect.width / 2), y: Math.floor(rect.top + rect.height / 2) }
  })()`)
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    ...normalPoint,
    button: 'left',
    clickCount: 1
  })
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    ...normalPoint,
    button: 'left',
    clickCount: 1
  })
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `document.activeElement?.matches('.month-day-cell[data-date="${key}"] .month-day-cell__quick-create input')`
      ),
    '普通数量区域未保留原有快速新建行为'
  )
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await window.webContents.executeJavaScript(
    `Promise.all(${JSON.stringify(ids)}.map((id) => window.api.deleteNote(id)))`
  )
  if (!isWeek) {
    for (const [width, edge, direction, closedClip] of [
      [720, 'first', 'right', 'inset(0 100% 0 0 round 12px)'],
      [720, 'last', 'left', 'inset(0 0 0 100% round 12px)'],
      [360, 'top-middle', 'bottom', 'inset(0 0 100% 0 round 12px)'],
      [360, 'bottom-middle', 'top', 'inset(100% 0 0 0 round 12px)']
    ]) {
      window.setSize(width, 700)
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(
            `window.innerWidth === ${width} && window.innerHeight === 700`
          ),
        '方向测试窗口尺寸未就绪'
      )
      // 原生窗口可在尺寸已读到后继续派发 resize；待其结束再打开会随 resize 关闭的菜单。
      await new Promise((resolve) => setTimeout(resolve, 300))
      await window.webContents.executeJavaScript(`(() => {
        const cells = Array.from(document.querySelectorAll('.month-day-cell'))
        const cell = ({ first: cells[0], last: cells.at(-1),
          'top-middle': cells[3], 'bottom-middle': cells.at(-4) })['${edge}']
        const rect = cell.getBoundingClientRect()
        cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
          clientX: rect.left + 8, clientY: rect.top + 8 }))
      })()`)
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(`(() => {
          const menu = document.querySelector('.month-cell-context-menu-shell')
          return menu && !menu.classList.contains('month-cell-context-menu-enter-active')
        })()`),
        '方向测试日期菜单未就绪'
      )
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.month-cell-context-menu button')).find((button) => button.textContent.includes('预览当日全部便签')).click()`
      )
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(
            `Boolean(document.querySelector('.month-day-preview.is-${direction}'))`
          ),
        `空间变化后预览没有选择 ${direction} 方向`
      ).catch(async (error) => {
        console.error(
          await window.webContents.executeJavaScript(`({
          preview: document.querySelector('.month-day-preview')?.outerHTML.slice(0, 400),
          menu: document.querySelector('.month-cell-context-menu-shell')?.outerHTML.slice(0, 300),
          viewport: [window.innerWidth, window.innerHeight]
        })`)
        )
        throw error
      })
      const motion = await window.webContents.executeJavaScript(
        `window.__countPreviewAnimations.at(-1)`
      )
      assert.equal(motion.frames[0].clipPath, closedClip, `${direction} 方向卷帘起点不正确`)
      await window.webContents.executeJavaScript(
        `document.querySelector('.month-day-preview [aria-label="关闭预览"]').click()`
      )
      await waitUntil(
        () => window.webContents.executeJavaScript(`!document.querySelector('.month-day-preview')`),
        '方向测试预览未关闭'
      )
      const leave = await window.webContents.executeJavaScript(
        `window.__countPreviewAnimations.at(-1)`
      )
      assert.equal(leave.frames.at(-1).clipPath, closedClip, `${direction} 方向收起终点不正确`)
    }
  }
  window.setBounds(originalBounds)
  await window.webContents.executeJavaScript(`(() => {
    Element.prototype.animate = window.__countPreviewOriginalAnimate
    delete window.__countPreviewOriginalAnimate
  })()`)
  process.stderr.write(
    `[count-preview] ${isWeek ? 'week' : 'month'} overflow, mouse, keyboard, resize and quick-create passed\n`
  )
}
