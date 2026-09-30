import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const require = createRequire(import.meta.url)
const profile = mkdtempSync(join(tmpdir(), 'abandon-note-list-completion-'))
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const report = (message) => process.stderr.write(`[list-completion] ${message}\n`)

async function until(predicate, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await wait(30)
  }
  throw new Error(message)
}

function listWindow() {
  return BrowserWindow.getAllWindows().find(
    (win) => !win.isDestroyed() && /\/index\.html(?:$|[?#])/.test(win.webContents.getURL())
  )
}

function seedSettings() {
  const db = new Database(join(profile, 'app.db'))
  db.exec(`CREATE TABLE app_settings (
    window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
    remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
    PRIMARY KEY (window_name, key)
  )`)
  const insert = db.prepare(
    'INSERT INTO app_settings (window_name, type, key, value) VALUES (?, ?, ?, ?)'
  )
  insert.run('application', 'application', 'active_view', 'list')
  insert.run('application', 'remote', 'receive_notices', 'false')
  insert.run('application', 'remote', 'upload_device_info', 'false')
  insert.run('application', 'onboarding', 'first_use_notice_version', '1')
  insert.run('main', 'system', 'blur_enabled', 'false')
  db.close()
}

async function run() {
  let win
  try {
    await until(() => listWindow(), '列表窗口未启动')
    win = listWindow()
    win.setSize(600, 780)
    const js = (code) => win.webContents.executeJavaScript(code)
    const expectUI = (code, message) => until(() => js(code), message)
    await expectUI(`Boolean(document.querySelector('.nl-timeline'))`, '时间线未渲染')
    const data = await js(`(async () => {
      const now = new Date()
      const at = (days, seconds) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 0, 0, seconds).getTime()
      const tag = await window.api.createTag('完成排序测试', '#3984db')
      const add = async (content, day, seconds, pinned = false) => {
        const note = await window.api.createNote({ content, effectiveAt: at(day, seconds), isPinned: pinned ? 1 : 0 })
        await window.api.setNoteTagIds(note.id, [tag.id])
        return note.id
      }
      const todayDone = await add('今天已完成', 0, 0)
      await window.api.completeNote(todayDone)
      const today = await add('今天待完成', 0, 2)
      const todayOther = await add('今天保留进行中', 0, 1)
      const yesterday = await add('昨天待完成', -1, 2)
      const yesterdayOther = await add('昨天保留进行中', -1, 1)
      const pinned = await add('置顶待完成', 0, 3, true)
      const old = []
      for (let i = 0; i < 35; i++) old.push(await add('更早分页 ' + i, -4, i))
      return { tagId: tag.id, todayDone, today, todayOther, yesterday, yesterdayOther, pinned, old }
    })()`)
    win.webContents.reload()
    await expectUI(
      `document.querySelectorAll('.nl-timeline .nl-card').length === 16`,
      '默认展开首批应显示最近/置顶 6 条和更早 10 条'
    )
    assert.equal(
      await js(
        `document.querySelector('.nl-group-chevron').classList.contains('nl-group-chevron--collapsed')`
      ),
      false
    )
    const groupIds = (label) =>
      js(`(() => {
      const group = [...document.querySelectorAll('.nl-group')].find(g => g.querySelector('.nl-group-label')?.textContent === ${JSON.stringify(label)})
      return [...(group?.querySelectorAll('.nl-card') || [])].map(c => Number(c.dataset.noteId))
    })()`)
    const complete = async (id) => {
      await js(`document.querySelector('.nl-card[data-note-id="${id}"] .sr-control').click()`)
      await expectUI(
        `window.api.getNote(${id}).then(n => n.status === 'completed')`,
        '完成状态未持久化'
      )
      await wait(1250)
    }
    await complete(data.today)
    assert.deepEqual(await groupIds('今天'), [data.todayOther, data.todayDone, data.today])
    await complete(data.yesterday)
    assert.deepEqual(await groupIds('昨天'), [data.yesterdayOther, data.yesterday])
    assert.equal((await groupIds('今天')).includes(data.yesterday), false)
    await complete(data.pinned)
    assert.equal((await groupIds('今天')).at(-1), data.pinned)
    assert.deepEqual(await groupIds('置顶'), [])
    await js(
      `document.querySelector('.nl-card[data-note-id="${data.pinned}"] .sr-control').click()`
    )
    await until(async () => (await groupIds('置顶')).includes(data.pinned), '重新进行未恢复置顶')
    assert.equal(await js(`window.api.getNote(${data.pinned}).then(n => n.is_pinned)`), 1)
    report('PASS today/yesterday completion, existing completed order, pin restoration')

    await complete(data.old.at(-1))
    await expectUI(
      `!document.querySelector('.nl-timeline .nl-card[data-note-id="${data.old.at(-1)}"]')`,
      '更早完成项应移到未加载的组末尾'
    )
    const scrollMore = async (count) => {
      await js(
        `(() => { const el = document.querySelector('.nl-timeline'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); })()`
      )
      await expectUI(
        `document.querySelectorAll('.nl-timeline .nl-card').length === ${count}`,
        '滚动追加数量错误'
      )
    }
    await scrollMore(36)
    await scrollMore(41)
    assert.equal(
      await js(
        `Number([...document.querySelectorAll('.nl-timeline .nl-card')].at(-1)?.dataset.noteId)`
      ),
      data.old.at(-1)
    )
    assert.equal(
      await js(
        `new Set([...document.querySelectorAll('.nl-timeline .nl-card')].map(c => c.dataset.noteId)).size`
      ),
      41
    )
    await js(`document.querySelector('.nl-group-label-row--earlier').click()`)
    await expectUI(
      `document.querySelectorAll('.nl-timeline .nl-card').length === 6`,
      '收起更早未移除卡片'
    )
    await js(`document.querySelector('.nl-group-label-row--earlier').click()`)
    await expectUI(
      `document.querySelectorAll('.nl-timeline .nl-card').length === 16`,
      '重新展开未恢复首批 10 条'
    )
    report('PASS earlier default open, completion across pages, 10/20 pagination, collapse/reopen')

    await js(
      `window.api.setSettingValue('listFilter', { listMode: 'tag-group', tagIds: [], statusFilter: [] })`
    )
    await expectUI(`Boolean(document.querySelector('.nl-tag-group-toggle'))`, '标签模式未加载')
    await js(`document.querySelector('.nl-tag-group-toggle').click()`)
    const taggedIds = () =>
      js(
        `[...document.querySelectorAll('.nl-tag-groups .nl-card')].map(c => Number(c.dataset.noteId))`
      )
    await until(async () => (await taggedIds()).length === 10, '标签首批应为 10 条')
    await complete(data.todayOther)
    await until(
      async () => !(await taggedIds()).includes(data.todayOther),
      '标签完成项未移到整个组末尾'
    )
    for (const count of [30, 41]) {
      await js(`document.querySelector('.nl-tag-group-more').click()`)
      await until(async () => (await taggedIds()).length === count, '标签更多分页数量错误')
    }
    assert.equal((await taggedIds()).at(-1), data.todayOther)
    assert.equal(new Set(await taggedIds()).size, 41)
    await js(
      `document.querySelector('.nl-tag-groups .nl-card[data-note-id="${data.todayOther}"] .sr-control').click()`
    )
    await until(
      async () => (await taggedIds()).indexOf(data.todayOther) < 10,
      '标签重新进行未回到未完成区域'
    )
    await js(
      `window.api.setSettingValue('listFilter', { listMode: 'timeline', tagIds: [], statusFilter: ['in_progress'] })`
    )
    await expectUI(`Boolean(document.querySelector('.nl-timeline'))`, '未切回时间线')
    await complete(data.todayOther)
    await expectUI(
      `!document.querySelector('.nl-timeline .nl-card[data-note-id="${data.todayOther}"]')`,
      '状态筛选未移除已完成项'
    )
    report('PASS tag completion/reopen, whole-group pagination, status filtering')
    win.webContents.reload()
    await expectUI(
      `Boolean(document.querySelector('.nl-group-chevron')) && !document.querySelector('.nl-group-chevron--collapsed')`,
      '重载后更早应默认展开'
    )
    report('PASS reload; all completion-list UI checks passed')
    app.exit(0)
  } catch (error) {
    if (win && !win.isDestroyed()) {
      report(
        await win.webContents.executeJavaScript(
          `document.querySelector('.note-list')?.innerText || document.body.innerText`
        )
      )
    }
    report(error?.stack || String(error))
    app.exit(1)
  }
}

try {
  app.setPath('userData', profile)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  seedSettings()
  require(resolve('out/main/index.js'))
  const mainChunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '缺少主进程构建')
  require(resolve('out/main/chunks', mainChunk))
  app.once('ready', () => void run())
} catch (error) {
  report(error?.stack || String(error))
  app.exit(1)
}
