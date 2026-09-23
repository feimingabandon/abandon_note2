import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const require = createRequire(import.meta.url)
const userData = mkdtempSync(join(tmpdir(), 'abandon-help-center-'))
const qaDir = resolve('tmp/help-center-qa')
mkdirSync(qaDir, { recursive: true })
app.commandLine.appendSwitch('disable-gpu')
// 禁用浏览器原生 smooth 仍应有应用自身的连续导航动效。
app.commandLine.appendSwitch('disable-smooth-scrolling')
app.setPath('userData', userData)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const db = new Database(join(userData, 'app.db'))
db.exec(`CREATE TABLE app_settings (
  window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER, PRIMARY KEY(window_name,key)
)`)
const put = db.prepare('INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)')
put.run('application', 'application', 'active_view', 'list')
put.run('application', 'remote', 'receive_notices', 'false')
put.run('application', 'remote', 'upload_device_info', 'false')
put.run('application', 'onboarding', 'first_use_notice_version', '1')
for (const scope of ['main', 'month', 'week']) put.run(scope, 'system', 'blur_enabled', 'false')
db.close()
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))
async function until(predicate, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await wait(30)
  }
  throw new Error(label)
}
const evaluate = (window, code) => window.webContents.executeJavaScript(code)
async function findView(mode) {
  const filename = mode === 'list' ? 'index' : mode
  const window = await until(
    () =>
      BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes(`/${filename}.html`)
      ),
    mode + ' 窗口未创建'
  )
  await until(
    () => evaluate(window, `Boolean(document.querySelector('[aria-controls="help-workspace"]'))`),
    '帮助入口未就绪'
  )
  return window
}
async function openHelp(window) {
  await evaluate(window, `document.querySelector('[aria-controls="help-workspace"]').click()`)
  await until(
    () => evaluate(window, `Boolean(document.querySelector('.help-search-field input'))`),
    '帮助未打开'
  )
  await wait(450)
}
async function verifyTextSelection(window) {
  const points = await evaluate(
    window,
    `(() => {
      const paragraph = document.querySelector('[data-anchor-id="safety-support"] .help-summary')
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode()) && !node.data.trim()) {}
      const start = node.data.search(/\\S/)
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, Math.min(node.length, start + 8))
      const rect = range.getBoundingClientRect()
      return {
        userSelect: getComputedStyle(paragraph).userSelect,
        from: { x: Math.ceil(rect.left + 1), y: Math.round(rect.top + rect.height / 2) },
        to: { x: Math.floor(rect.right - 1), y: Math.round(rect.top + rect.height / 2) }
      }
    })()`
  )
  assert.equal(points.userSelect, 'text', '帮助正文没有恢复文本选择模式')
  window.webContents.sendInputEvent({ type: 'mouseMove', ...points.from })
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    ...points.from,
    button: 'left',
    clickCount: 1
  })
  for (let step = 1; step <= 6; step += 1) {
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(points.from.x + ((points.to.x - points.from.x) * step) / 6),
      y: points.from.y,
      button: 'left'
    })
    await wait(16)
  }
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    ...points.to,
    button: 'left',
    clickCount: 1
  })
  assert.ok(
    await evaluate(window, `window.getSelection().toString().trim().length > 0`),
    '帮助正文无法通过鼠标拖动选中文字'
  )
  await evaluate(window, `window.getSelection().removeAllRanges()`)
}
async function closeHelp(window) {
  await evaluate(window, `document.querySelector('.help-page-close').click()`)
  await until(() => evaluate(window, `!document.querySelector('.help-page')`), '帮助没有关闭')
}
async function search(window, query) {
  await evaluate(
    window,
    `(() => { const input = document.querySelector('.help-search-field input'); input.value = ${JSON.stringify(query)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`
  )
  await wait(60)
}
async function recordScrollMotion(window, action) {
  return evaluate(
    window,
    `new Promise(resolve => {
    const container = document.querySelector('.help-content')
    const samples = [container.scrollTop]
    const started = performance.now()
    ;${action};
    const sample = () => {
      samples.push(container.scrollTop)
      if (performance.now() - started < 1100) requestAnimationFrame(sample)
      else resolve(samples)
    }
    requestAnimationFrame(sample)
  })`
  )
}
function assertScrollMotion(samples, label) {
  const from = samples[0]
  const to = samples.at(-1)
  assert.ok(Math.abs(to - from) > 80, label + ' 未移动到其他内容')
  const lower = Math.min(from, to) + 2
  const upper = Math.max(from, to) - 2
  assert.ok(
    new Set(samples.filter((top) => top > lower && top < upper)).size >= 6,
    label + ' 缺少连续中间帧'
  )
}
async function navigateView(window, mode) {
  await evaluate(window, `document.querySelector('.view-switcher__trigger').click()`)
  await until(
    () =>
      evaluate(
        window,
        `Boolean(document.querySelector('.view-switcher__menu [data-view="${mode}"]'))`
      ),
    '视图选择未打开'
  )
  await evaluate(
    window,
    `document.querySelector('.view-switcher__menu [data-view="${mode}"]').click()`
  )
  return findView(mode)
}

require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
require(resolve('out/main/chunks', chunk))
app.once('ready', () => void run())
async function run() {
  try {
    let window = await findView('list')
    for (const mode of ['list', 'month', 'week']) {
      if (mode !== 'list') window = await navigateView(window, mode)
      window.setMinimumSize(320, 360)
      window.setContentSize(mode === 'list' ? 400 : 1100, 750)
      await openHelp(window)
      await verifyTextSelection(window)
      await until(
        () =>
          evaluate(
            window,
            `(() => {
        const support = document.querySelector('[data-anchor-id="safety-support"]')
        const images = [...support.querySelectorAll('img')]
        return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0 && !image.closest('details') && image.getBoundingClientRect().height > 50)
      })()`
          ),
        '首页两个二维码没有直接展示或加载失败'
      )
      assert.ok(
        await evaluate(
          window,
          `(() => {
        const reading = document.querySelector('.help-reading')
        const support = reading.firstElementChild
        return support.dataset.anchorId === 'safety-support' && support.querySelectorAll('a').length === 3 && support.textContent.includes('1160653906@qq.com')
      })()`
        ),
        '三个视图都应先显示首页二维码、项目地址和邮箱'
      )
      assert.ok(
        await evaluate(
          window,
          `(() => { const article = document.querySelector('[data-anchor-id="notes-create"]'); return ['日期格右键新建','日期侧栏新建','便签列表'].every(text => article.textContent.includes(text)); })()`
        ),
        '同一功能未包含跨视图入口'
      )
      await search(window, '持续到完成 跨日')
      assert.ok(
        await evaluate(
          window,
          `Boolean(document.querySelector('[data-help-result="note-duration"] mark'))`
        ),
        '搜索未命中正文或未高亮'
      )
      assertScrollMotion(
        await recordScrollMotion(
          window,
          `document.querySelector('[data-help-result="note-duration"]').click()`
        ),
        '搜索结果导航'
      )
      await until(
        () =>
          evaluate(
            window,
            `(() => { const container = document.querySelector('.help-content'); const article = document.querySelector('[data-anchor-id="note-duration"]'); return !document.querySelector('.help-results') && Math.abs(article.getBoundingClientRect().top-container.getBoundingClientRect().top-16) < 5; })()`
          ),
        '搜索结果未准确跳转正文'
      )
      assert.equal(await evaluate(window, `document.activeElement.textContent`), '便签持续方式')
      const readingTop = await evaluate(window, `document.querySelector('.help-content').scrollTop`)
      await search(window, '不可能有的关键词12345')
      assert.ok(
        await evaluate(window, `Boolean(document.querySelector('.help-empty'))`),
        '无结果状态缺失'
      )
      await evaluate(
        window,
        `document.querySelector('.help-search-field input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
      )
      await until(
        () =>
          evaluate(
            window,
            `Math.abs(document.querySelector('.help-content').scrollTop - ${readingTop}) < 4`
          ),
        '清除搜索后未恢复原阅读位置'
      )

      // 中文输入法候选确认的 Enter 不应打开搜索结果。
      await search(window, '新建')
      await evaluate(
        window,
        `document.querySelector('.help-search-field input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))`
      )
      assert.ok(await evaluate(window, `Boolean(document.querySelector('.help-results'))`))
      // 关闭搜索中的帮助也应保存此前正文阅读位置。
      await closeHelp(window)
      await openHelp(window)
      await until(
        () =>
          evaluate(
            window,
            `Math.abs(document.querySelector('.help-content').scrollTop - ${readingTop}) < 4`
          ),
        '重开帮助未恢复各视图阅读位置'
      )
      assertScrollMotion(
        await recordScrollMotion(window, `document.querySelector('.help-back-to-top').click()`),
        '回到顶部'
      )
      await until(
        () => evaluate(window, `document.querySelector('.help-content').scrollTop < 2`),
        '回到顶部失败'
      )
      assertScrollMotion(
        await recordScrollMotion(
          window,
          `document.querySelector('.help-quick-links button').click()`
        ),
        '首页快捷入口'
      )
      if (mode === 'list') await evaluate(window, `document.querySelector('.help-nav-fab').click()`)
      assertScrollMotion(
        await recordScrollMotion(
          window,
          `[...document.querySelectorAll('.help-nav-item')].find(button => button.textContent.includes('首页')).click()`
        ),
        '功能目录'
      )
      await evaluate(
        window,
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`
      )
      assert.ok(
        await evaluate(
          window,
          `document.activeElement === document.querySelector('.help-search-field input')`
        ),
        'Ctrl+F 未聚焦帮助搜索'
      )
      await search(window, '<script>.*[')
      assert.ok(
        await evaluate(window, `Boolean(document.querySelector('.help-empty'))`),
        '特殊字符搜索不应报错或注入内容'
      )
      await search(window, '')

      for (const theme of ['white', 'black', 'complex']) {
        await evaluate(
          window,
          `(() => {
          const root = document.documentElement;
          root.style.setProperty('--bg-color', '${theme === 'white' ? '255 255 255' : theme === 'black' ? '5 5 5' : '30 57 72'}');
          root.style.setProperty('--text-color', '${theme === 'white' ? '#151515' : '#f5f5f5'}');
          document.querySelector('.help-page').style.background = '${theme === 'complex' ? 'linear-gradient(130deg, rgba(20,40,54,.98), rgba(75,45,38,.98), rgba(25,70,63,.98))' : 'rgb(var(--bg-color))'}';
        })()`
        )
        await wait(80)
        writeFileSync(join(qaDir, `${mode}-${theme}.png`), (await window.capturePage()).toPNG())
      }
      assert.ok(
        await evaluate(
          window,
          `(() => { const content = document.querySelector('.help-content'); return content.scrollWidth <= content.clientWidth + 1; })()`
        ),
        '帮助正文横向溢出'
      )
      if (mode === 'list') {
        await evaluate(window, `document.querySelector('.help-nav-fab').click()`)
        await wait(250)
        assert.equal(
          await evaluate(
            window,
            `getComputedStyle(document.querySelector('.help-nav')).visibility`
          ),
          'visible'
        )
        await evaluate(window, `document.querySelector('.help-nav-head button').click()`)
        await wait(250)
        assert.equal(
          await evaluate(
            window,
            `getComputedStyle(document.querySelector('.help-nav')).visibility`
          ),
          'hidden'
        )
      }
      const quickLinkTitles = await evaluate(
        window,
        `[...document.querySelectorAll('.help-quick-links button')].map(button => button.textContent.replace('↗', '').trim())`
      )
      assert.equal(quickLinkTitles.length, 4, `${mode}: 帮助首页快捷入口缺失`)
      assert.ok(quickLinkTitles.includes('便签持续方式'), `${mode}: 持续方式快捷入口缺失`)
      await evaluate(
        window,
        `[...document.querySelectorAll('.help-quick-links button')].find(button => button.textContent.includes('便签持续方式')).click()`
      )
      await until(
        () =>
          evaluate(
            window,
            `document.activeElement === document.querySelector('[data-anchor-id="note-duration"] h2')`
          ),
        `${mode}: 持续方式快捷入口没有定位到对应文章`
      )
      await search(window, '持续到完成')
      writeFileSync(join(qaDir, `${mode}-search.png`), (await window.capturePage()).toPNG())
      await closeHelp(window)
    }
    process.stderr.write(
      'help center: all views, full-text search, IME, anchors, reading restoration, narrow layout and theme screenshots passed\n'
    )
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error.stack}\n`)
    const window = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
    if (window) writeFileSync(join(qaDir, 'failure.png'), (await window.capturePage()).toPNG())
    app.exit(1)
  }
}
app.on('will-quit', () => {
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* 退出时可能仍持有数据库。 */
  }
})
