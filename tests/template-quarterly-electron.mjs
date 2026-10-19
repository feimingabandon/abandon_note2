import { mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const require = createRequire(import.meta.url)
const WAIT_STEP_MS = 25

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(WAIT_STEP_MS)
  }
  throw new Error(message)
}

function seedListView(userDataPath) {
  mkdirSync(userDataPath, { recursive: true })
  const db = new Database(join(userDataPath, 'app.db'))
  db.exec(`
    CREATE TABLE app_settings (
      window_name TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      remark TEXT DEFAULT '',
      created_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (window_name, key)
    );
  `)
  const insert = db.prepare(`
    INSERT INTO app_settings
      (window_name, type, key, value, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, ?)
  `)
  const now = Date.now()
  insert.run('application', 'application', 'active_view', 'list', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('main', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getListWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) =>
      !window.isDestroyed() &&
      /\/index\.html(?:$|[?#])/.test(window.webContents.getURL()) &&
      !/\/sticky\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/template-quarterly-electron.mjs',
  mode: 'real-app-quarterly-template-and-continuous-create',
  prefix: 'abandon-note-quarterly-template-e2e-',
  metadata: { realRendererAndPreload: true, diskDatabase: true, mainProcessRestart: false }
})
const { assert } = lifecycle
const testUserData = lifecycle.root
let listWindow
let latestPreview
let nextTemplateMutationGate = null
const activeMutationGates = new Set()
function gateNextTemplateMutation(channel, error = null) {
  let release
  const promise = new Promise((done) => {
    release = done
  })
  const gate = { channel, error, promise, release, started: false }
  nextTemplateMutationGate = gate
  activeMutationGates.add(gate)
  return gate
}
function releaseTemplateMutationGates() {
  for (const gate of activeMutationGates) gate.release()
  activeMutationGates.clear()
  nextTemplateMutationGate = null
}
const originalHandle = ipcMain.handle
ipcMain.handle = function (channel, handler) {
  if (!['templates:preview-next-run', 'templates:create', 'templates:update'].includes(channel))
    return originalHandle.call(this, channel, handler)
  return originalHandle.call(this, channel, async (...args) => {
    const gate = nextTemplateMutationGate
    if (gate?.channel === channel) {
      nextTemplateMutationGate = null
      gate.started = true
      await gate.promise
      activeMutationGates.delete(gate)
      if (gate.error) throw new Error(gate.error)
    }
    const result = await handler(...args)
    if (channel === 'templates:preview-next-run') latestPreview = { fields: args[1], result }
    return result
  })
}

async function runQuarterlyTemplateTest() {
  try {
    listWindow = await waitUntil(() => getListWindow(), '列表主窗口没有启动', 10000)
    await waitUntil(() => listWindow.isVisible(), '列表主窗口没有显示')
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.titlebar-btn-template'))`
        ),
      '列表导航栏没有循环模板入口'
    )

    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.titlebar-btn-template').click()`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.app-template-panel')?.classList.contains('active')`
        ),
      '循环模板工作区没有打开'
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `(() => {
            const box = document.querySelector('.app-template-panel .tcp-box')
            if (!box) return false
            const rect = box.getBoundingClientRect()
            return rect.left + 44 < window.innerWidth && rect.right > 0
          })()`
        ),
      '循环模板新建区域没有进入可见范围'
    )
    const createBoxTarget = await listWindow.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector('.app-template-panel .tcp-box').getBoundingClientRect()
      const point = {
        x: Math.round(Math.max(rect.left + 44, Math.min(rect.right, window.innerWidth) - 20)),
        y: Math.round((rect.top + rect.bottom) / 2)
      }
      const target = document.elementFromPoint(point.x, point.y)
      return {
        point,
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        target: { tagName: target?.tagName || null, className: target?.className || null },
        inCreateBox: Boolean(target?.closest('.tcp-box'))
      }
    })()`)
    assert.equal(
      createBoxTarget.inCreateBox,
      true,
      `整框点击坐标必须命中新建循环模板区域: ${JSON.stringify(createBoxTarget)}`
    )
    const collapsedHint = await listWindow.webContents.executeJavaScript(`(() => {
      const hint = document.querySelector('.app-template-panel .tcp-hint')
      if (!hint) return null
      const style = getComputedStyle(hint)
      const rect = hint.getBoundingClientRect()
      return {
        text: hint.textContent.trim(),
        opacity: Number(style.opacity),
        visibility: style.visibility,
        width: rect.width,
        height: rect.height
      }
    })()`)
    assert.equal(collapsedHint?.text, '请新建循环模板内容…')
    assert.equal(collapsedHint?.visibility, 'visible')
    assert.ok(collapsedHint?.opacity > 0.5, JSON.stringify(collapsedHint))
    assert.ok(collapsedHint?.width > 0 && collapsedHint?.height > 0)
    listWindow.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...createBoxTarget.point
    })
    listWindow.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...createBoxTarget.point
    })
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.app-template-panel .tcp-content')?.classList.contains('visible')`
        ),
      '循环模板新建表单没有展开'
    )
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `document.querySelector('.app-template-panel .tf-root .reminder-channels__trigger')?.textContent.trim()`
      ),
      '不提醒',
      '新模板提醒必须默认关闭'
    )
    const lifecycleFields = await listWindow.webContents.executeJavaScript(`(() => ({
      labels: Array.from(document.querySelectorAll('.app-template-panel .tf-time-range label'),
        (node) => node.childNodes[0]?.textContent.trim()),
      pickers: document.querySelectorAll('.app-template-panel .tf-time-range .dt-wrapper').length
    }))()`)
    assert.deepEqual(lifecycleFields.labels, ['开始时间', '结束时间'])
    assert.equal(lifecycleFields.pickers, 2)
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.app-template-panel .tf-time-range .dt-trigger').click()`
    )
    const lifecyclePickerLayout = await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(`(() => {
          const trigger = document.querySelector('.app-template-panel .tf-time-range .dt-wrapper')
          const panel = document.querySelector('.dt-panel-wrap')
          if (!trigger || !panel) return null
          const triggerRect = trigger.getBoundingClientRect()
          const panelRect = panel.getBoundingClientRect()
          return {
            trigger: { left: triggerRect.left, right: triggerRect.right, width: triggerRect.width },
            panel: { left: panelRect.left, right: panelRect.right, top: panelRect.top,
              bottom: panelRect.bottom, width: panelRect.width, height: panelRect.height },
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            horizontalOverflow: panel.scrollWidth - panel.clientWidth,
            clippedControls: [...panel.querySelectorAll('button')].filter(button => {
              const rect = button.getBoundingClientRect()
              return rect.width > 0 && rect.height > 0 &&
                (rect.left < panelRect.left - 2 || rect.right > panelRect.right + 2 ||
                  button.scrollWidth > button.clientWidth + 2)
            }).map(button => button.textContent.trim()),
            remSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
          }
        })()`),
      '模板开始时间选择面板没有打开'
    )
    assert.ok(
      lifecyclePickerLayout.trigger.width >= 220 * lifecyclePickerLayout.remSize - 3,
      JSON.stringify(lifecyclePickerLayout)
    )
    // The picker uses its 320rem content width, independently of a flexible form trigger.
    const expectedPickerWidth = Math.min(
      320 * lifecyclePickerLayout.remSize,
      lifecyclePickerLayout.viewportWidth - 16
    )
    assert.ok(
      Math.abs(lifecyclePickerLayout.panel.width - expectedPickerWidth) <= 2,
      JSON.stringify(lifecyclePickerLayout)
    )
    const expectedPickerLeft = Math.max(
      8,
      Math.min(
        lifecyclePickerLayout.trigger.left,
        lifecyclePickerLayout.viewportWidth - lifecyclePickerLayout.panel.width - 8
      )
    )
    assert.ok(
      Math.abs(expectedPickerLeft - lifecyclePickerLayout.panel.left) <= 2,
      JSON.stringify(lifecyclePickerLayout)
    )
    assert.ok(lifecyclePickerLayout.panel.left >= 7)
    assert.ok(lifecyclePickerLayout.panel.right <= lifecyclePickerLayout.viewportWidth - 7)
    assert.ok(lifecyclePickerLayout.panel.top >= 7)
    assert.ok(lifecyclePickerLayout.panel.bottom <= lifecyclePickerLayout.viewportHeight - 7)
    assert.ok(lifecyclePickerLayout.horizontalOverflow <= 2, JSON.stringify(lifecyclePickerLayout))
    assert.deepEqual(
      lifecyclePickerLayout.clippedControls,
      [],
      '日期选择器按钮文字和水平控件不能裁切'
    )
    await listWindow.webContents.executeJavaScript(`(() => {
      const confirm = document.querySelector('.dt-panel-wrap .dt-btn--confirm')
      confirm.scrollIntoView({block:'nearest'})
      confirm.focus({preventScroll:true})
    })()`)
    const confirmReachable = await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.dt-panel-wrap')
      const button = panel?.querySelector('.dt-btn--confirm')
      if (!button) return false
      const rect = button.getBoundingClientRect()
      const target = document.elementFromPoint((rect.left+rect.right)/2,(rect.top+rect.bottom)/2)
      return rect.width > 0 && rect.height > 0 && !button.disabled &&
        (target === button || button.contains(target)) && document.activeElement === button
    })()`),
      '日期选择器确认按钮在浮层内部滚动后必须可见、可命中且可聚焦'
    )
    assert.equal(confirmReachable, true)
    listWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    listWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })

    const frequencyCount = await listWindow.webContents.executeJavaScript(
      `document.querySelectorAll('.app-template-panel .tfs-segments button').length`
    )
    assert.equal(frequencyCount, 5, '模板频率必须包含天、周、月、季、年五项')
    await listWindow.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.app-template-panel .tfs-segments button'))
        .find((node) => node.textContent.trim() === '季')
      button.click()
    })()`)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.app-template-panel .tfs-quarter-months'))`
        ),
      '自然季度规则面板没有显示'
    )

    const defaults = await listWindow.webContents.executeJavaScript(`(() => ({
      quarterMonth: document.querySelector('.app-template-panel .tfs-quarter-months button.active')?.textContent.trim(),
      days: Array.from(document.querySelectorAll('.app-template-panel .tfs-panel .tfs-monthdays button.active'),
        (node) => Number(node.textContent.trim()))
    }))()`)
    assert.equal(defaults.quarterMonth, '第 3 月')
    assert.deepEqual(defaults.days, [31])

    await listWindow.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.app-template-panel .tfs-quarter-months button')[1].click()
      const day15 = Array.from(document.querySelectorAll('.app-template-panel .tfs-panel .tfs-monthdays button'))
        .find((node) => node.textContent.trim() === '15')
      day15.click()
      const textarea = document.querySelector('.app-template-panel .tf-root textarea')
      textarea.focus()
    })()`)
    listWindow.webContents.insertText('自然季度集成测试')
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.app-template-panel .tf-preview strong.is-time'))`
        ),
      '自然季度下一次生成时间没有通过 IPC 完成预览'
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.app-template-panel .tf-submit')?.disabled === false`
        ),
      '循环模板创建按钮没有在表单有效后启用'
    )
    const beforeSubmit = await listWindow.webContents.executeJavaScript(`(() => {
      const submit = document.querySelector('.app-template-panel .tf-submit')
      return {
        disabled: submit?.disabled ?? null,
        label: submit?.textContent.trim() || '',
        preview:
          document
            .querySelector('.app-template-panel .tf-preview strong')
            ?.textContent.trim() || ''
      }
    })()`)
    assert.equal(beforeSubmit.disabled, false, JSON.stringify(beforeSubmit))
    const firstPreview = latestPreview
    assert.equal(firstPreview.fields.recurrenceRule.frequency, 'quarterly')
    assert.equal(firstPreview.fields.recurrenceRule.month_of_quarter, 2)
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.app-template-panel .tf-submit').click()`
    )
    const saved = await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(`window.api.listTemplates({ state: 'all' }).then(
          (items) => items.find((item) => item.content === '自然季度集成测试') || null
        )`),
      '自然季度模板没有保存到数据库'
    )
    const rule = JSON.parse(saved.recurrence_rule)
    assert.equal(rule.frequency, 'quarterly')
    assert.equal(rule.month_of_quarter, 2)
    assert.deepEqual(rule.days_of_month, [15, 31])
    assert.ok(Number.isFinite(Number(saved.start_at)))
    assert.equal(saved.end_at, null)
    assert.equal(saved.reminder_channels, 0)
    assert.equal(saved.notify_enabled, 0)
    assert.equal(saved.next_run_at, firstPreview.result, '预览与实际保存的生成节点必须一致')
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.app-template-panel .tp-list')?.textContent.includes('每季度次月 15、31 日')`
        ),
      '模板卡片没有显示自然季度摘要'
    )

    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `!window.__prepareEditingDrafts().blocked && !document.querySelector('.app-template-panel .tf-root textarea').value`
        ),
      '创建成功后正文没有清空或保存状态未解除'
    )
    const inherited = await listWindow.webContents.executeJavaScript(`(() => ({
      open: document.querySelector('.tcp-content')?.classList.contains('visible'),
      frequency: document.querySelector('.tcp-content .tfs-segments button.active')?.textContent.trim(),
      quarterMonth: document.querySelector('.tcp-content .tfs-quarter-months button.active')?.textContent.trim(),
      days: [...document.querySelectorAll('.tcp-content .tfs-monthdays button.active')].map(b=>Number(b.textContent.trim())),
      dirty: window.__prepareEditingDrafts().dirty
    }))()`)
    assert.equal(inherited.open, true)
    assert.equal(inherited.frequency, '季')
    assert.equal(inherited.quarterMonth, '第 2 月')
    assert.deepEqual(inherited.days, [15, 31])
    assert.equal(inherited.dirty, false, '只有继承的选项不属于未保存便签')

    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.tcp-content .reminder-channels__trigger').click()`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `!!document.querySelector('.reminder-channels__panel')`
        ),
      '循环提醒选项没有打开'
    )
    await listWindow.webContents.executeJavaScript(`(() => {
      [...document.querySelectorAll('.reminder-channels__option')].find(b=>b.textContent.includes('托盘闪烁')).click()
      document.querySelector('.tcp-content .reminder-channels__trigger').click()
      const textarea = document.querySelector('.tcp-content textarea')
      textarea.focus()
    })()`)
    assert.equal(
      await listWindow.webContents.executeJavaScript(`window.__prepareEditingDrafts().dirty`),
      false,
      '仅调整下一条模板选项不能提示未保存正文'
    )
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.tcp-content textarea').focus()`
    )
    listWindow.webContents.insertText('自然季度连续创建')
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.tcp-content .tf-submit')?.disabled === false`
        ),
      '连续创建不能使用沿用设置提交'
    )
    const secondPreview = latestPreview
    await listWindow.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('.tcp-content .ts-more')
      // Owned popovers close when their anchor is clipped by the scrollport.
      // Keep this anchor visible before testing a panel that survives submission.
      trigger.scrollIntoView({block:'center'})
      trigger.click()
    })()`)
    await waitUntil(
      () => listWindow.webContents.executeJavaScript(`!!document.querySelector('.ts-panel')`),
      '提交锁定验证前标签面板没有打开'
    )
    await listWindow.webContents.executeJavaScript(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    )
    assert.equal(
      await listWindow.webContents.executeJavaScript(`!!document.querySelector('.ts-panel')`),
      true,
      '锁定测试使用的标签浮层必须有可见锚点并保持展开'
    )
    const secondCreateGate = gateNextTemplateMutation('templates:create')
    // Submitting the form keeps the open panel in place, independently of any
    // normal outside-pointer dismissal caused by clicking the save button.
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.tcp-content .tf-root').requestSubmit()`
    )
    await waitUntil(() => secondCreateGate.started, '第二次创建没有进入受控保存等待')
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.tcp-content .tf-fields')?.inert && document.querySelector('.ts-panel')?.inert`
        ),
      '模板保存期间字段和已打开的 Teleport 标签面板必须一起锁定'
    )
    const createLock = await listWindow.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector('.tcp-content textarea')
      textarea.focus()
      return { focused: document.activeElement === textarea, content: textarea.value,
        reminder: document.querySelector('.tcp-content .reminder-channels__trigger').textContent.trim() }
    })()`)
    assert.equal(createLock.focused, false, '保存期间正文不能重新取得输入焦点')
    assert.equal(createLock.content, '自然季度连续创建')
    listWindow.webContents.insertText('保存期间禁止输入')
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `document.querySelector('.tcp-content textarea').value`
      ),
      '自然季度连续创建',
      '保存期间真实输入不能修改即将清空的正文'
    )
    assert.equal(createLock.reminder, '托盘闪烁')
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.tp-search input').focus()`
    )
    secondCreateGate.release()
    const secondSaved = await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `window.api.listTemplates({state:'all'}).then(items=>items.find(t=>t.content==='自然季度连续创建'))`
        ),
      '连续创建的第二个循环模板没有保存'
    )
    assert.deepEqual(JSON.parse(secondSaved.recurrence_rule), rule)
    assert.equal(secondSaved.reminder_channels, 4)
    assert.equal(secondSaved.next_run_at, secondPreview.result)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `!window.__prepareEditingDrafts().blocked && !document.querySelector('.tcp-content textarea').value`
        ),
      '第二次创建没有完成重置'
    )
    const secondReset = await listWindow.webContents.executeJavaScript(`(() => ({
      open: document.querySelector('.tcp-content').classList.contains('visible'),
      reminder: document.querySelector('.tcp-content .reminder-channels__trigger').textContent.trim(),
      focusPreserved: document.activeElement === document.querySelector('.tp-search input'),
      dirty: window.__prepareEditingDrafts().dirty
    }))()`)
    assert.equal(secondReset.open, true)
    assert.equal(secondReset.reminder, '托盘闪烁')
    assert.equal(secondReset.focusPreserved, true, '成功重置不能抢回用户已移开的焦点')
    assert.equal(secondReset.dirty, false)
    assert.equal(
      await listWindow.webContents.executeJavaScript(`document.querySelector('.ts-panel')?.inert`),
      false,
      '保存结束后 Teleport 面板不能残留 inert'
    )
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.tcp-content .ts-more').click()`
    )

    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.app-template-panel .tp-filter-button').click()`
    )
    const statusFilterState = () =>
      listWindow.webContents.executeJavaScript(`(() => ({
        selected: Array.from(document.querySelectorAll('.app-template-panel .tp-filter-chips button[aria-pressed="true"]'),
          (button) => button.textContent.trim()),
        cardVisible: Boolean(document.querySelector('.app-template-panel .tc-card[data-template-id="${Number(saved.id)}"]'))
      }))()`)
    assert.deepEqual((await statusFilterState()).selected, ['全部'])
    await listWindow.webContents.executeJavaScript(`(() => {
      const buttons = Array.from(document.querySelectorAll('.app-template-panel .tp-filter-chips button'))
      buttons.find((button) => button.textContent.trim() === '运行中').click()
      buttons.find((button) => button.textContent.trim() === '已暂停').click()
    })()`)
    await waitUntil(async () => {
      const status = await statusFilterState()
      return status.selected.join(',') === '运行中,已暂停' && status.cardVisible
    }, '模板状态未支持同时选择运行中和已暂停')
    await listWindow.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.app-template-panel .tp-filter-chips button'))
        .find((item) => item.textContent.trim() === '运行中')
      button.click()
    })()`)
    await waitUntil(async () => {
      const status = await statusFilterState()
      return status.selected.join(',') === '已暂停' && !status.cardVisible
    }, '取消运行中后，已暂停筛选仍显示运行中的模板')
    await listWindow.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.app-template-panel .tp-filter-chips button'))
        .find((item) => item.textContent.trim() === '全部')
      button.click()
    })()`)
    await waitUntil(async () => {
      const status = await statusFilterState()
      return status.selected.join(',') === '全部' && status.cardVisible
    }, '选择全部后没有恢复模板列表')

    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.tc-card[data-template-id="${Number(saved.id)}"] .tc-more').click()`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(Array.from(document.querySelectorAll('.tc-menu button')).find((node) => node.textContent.trim() === '修改'))`
        ),
      '季度模板操作菜单没有打开'
    )
    await listWindow.webContents.executeJavaScript(`(() => {
      const edit = Array.from(document.querySelectorAll('.tc-menu button'))
        .find((node) => node.textContent.trim() === '修改')
      edit.click()
    })()`)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.tp-edit-dialog .tfs-quarter-months'))`
        ),
      '修改季度模板时没有恢复季度规则面板'
    )
    const editValues = await listWindow.webContents.executeJavaScript(`(() => ({
      frequency: document.querySelector('.tp-edit-dialog .tfs-segments button.active')?.textContent.trim(),
      quarterMonth: document.querySelector('.tp-edit-dialog .tfs-quarter-months button.active')?.textContent.trim(),
      days: Array.from(document.querySelectorAll('.tp-edit-dialog .tfs-panel .tfs-monthdays button.active'),
        (node) => Number(node.textContent.trim())),
      lifecycle: Array.from(document.querySelectorAll('.tp-edit-dialog .tf-time-range .dt-label'),
        (node) => node.textContent.trim())
    }))()`)
    assert.equal(editValues.frequency, '季')
    assert.equal(editValues.quarterMonth, '第 2 月')
    assert.deepEqual(editValues.days, [15, 31])
    assert.match(editValues.lifecycle[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.equal(editValues.lifecycle[1], '永不结束')

    await listWindow.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector('.tp-edit-dialog textarea')
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    })()`)
    listWindow.webContents.insertText('，修改草稿')
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.tp-edit-dialog .tf-submit')?.disabled === false`
        ),
      '模板修改正文后保存按钮未启用'
    )
    const editedContent = '自然季度集成测试，修改草稿'
    const failedEditGate = gateNextTemplateMutation(
      'templates:update',
      '提交锁定回归：预期保存失败'
    )
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.tp-edit-dialog .tf-submit').click()`
    )
    await waitUntil(() => failedEditGate.started, '模板修改没有进入受控失败等待')
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `document.querySelector('.tp-edit-dialog .tf-fields').inert`
      ),
      true,
      '修改模板保存期间必须锁定输入'
    )
    failedEditGate.release()
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.tp-edit-dialog .tf-fields')?.inert === false && document.querySelector('.tp-edit-dialog .tf-submit')?.disabled === false`
        ),
      '失败后模板编辑器没有恢复输入和保存'
    )
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `document.querySelector('.tp-edit-dialog textarea').value`
      ),
      editedContent,
      '保存失败必须保留修改草稿'
    )
    const successfulEditGate = gateNextTemplateMutation('templates:update')
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.tp-edit-dialog .tf-submit').click()`
    )
    await waitUntil(() => successfulEditGate.started, '模板修改重试没有进入受控保存等待')
    const editLock = await listWindow.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector('.tp-edit-dialog textarea')
      textarea.focus()
      return { inert: document.querySelector('.tp-edit-dialog .tf-fields').inert,
        focused: document.activeElement === textarea, content: textarea.value }
    })()`)
    assert.equal(editLock.inert, true)
    assert.equal(editLock.focused, false)
    listWindow.webContents.insertText('保存期间禁止输入')
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `document.querySelector('.tp-edit-dialog textarea').value`
      ),
      editedContent,
      '修改保存期间的真实输入不能更改已提交正文'
    )
    successfulEditGate.release()
    await waitUntil(
      () => listWindow.webContents.executeJavaScript(`!document.querySelector('.tp-edit-dialog')`),
      '修改保存成功后编辑器没有关闭'
    )
    const editedSaved = await listWindow.webContents.executeJavaScript(
      `window.api.listTemplates({state:'all'}).then(items=>items.find(t=>t.id===${Number(saved.id)}))`
    )
    assert.equal(editedSaved.content, editedContent)

    await lifecycle.finish({
      completed: true,
      window: listWindow,
      summary: {
        firstTemplateId: saved.id,
        secondTemplateId: secondSaved.id,
        previewsMatchSavedNodes: true
      },
      restore: () => {
        releaseTemplateMutationGates()
        ipcMain.handle = originalHandle
      }
    })
  } catch (error) {
    console.error(error)
    await lifecycle.finish({
      error,
      window: listWindow,
      restore: () => {
        releaseTemplateMutationGates()
        ipcMain.handle = originalHandle
      }
    })
  }
}

try {
  app.setPath('userData', testUserData)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve(
    'native_blur',
    'build',
    'bin',
    'blur_engine.dll'
  )
  seedListView(testUserData)

  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void runQuarterlyTemplateTest())
} catch (error) {
  console.error(error)
  await lifecycle.finish({
    error,
    restore: () => {
      ipcMain.handle = originalHandle
    }
  })
}
