import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const script = fileURLToPath(import.meta.url)
const phase = process.argv.find((arg) => arg.startsWith('--scroll-phase='))?.split('=')[1]
const profileArg = process.argv.find((arg) => arg.startsWith('--scroll-profile='))
const output = resolve('tmp/settings-scroll-memory-results.json')
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

if (!phase) {
  // Two real application processes share a profile: only a new runtime may reset the memory.
  const profile = mkdtempSync(join(tmpdir(), 'abandon-settings-scroll-'))
  app.setPath('userData', join(profile, 'runner'))
  const childEnvironment = { ...process.env }
  delete childEnvironment.ELECTRON_RUN_AS_NODE
  const runChild = (step) =>
    new Promise((done, fail) => {
      const child = spawn(
        process.execPath,
        [script, `--scroll-phase=${step}`, `--scroll-profile=${profile}`],
        {
          env: childEnvironment,
          stdio: 'inherit',
          windowsHide: true
        }
      )
      child.once('error', fail)
      child.once('exit', (code) =>
        code === 0 ? done() : fail(new Error(`${step} exited ${code}`))
      )
    })
  app
    .whenReady()
    .then(async () => {
      await runChild('remember')
      await runChild('restart')
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(
        output,
        JSON.stringify(
          {
            status: 'passed',
            profile,
            checks: [
              'all three views',
              'close and reopen',
              'restore before entrance',
              'cross-view navigation',
              'renderer reload',
              'search motion cancelled on close',
              'compact settings typography and five content groups',
              'precise setting search and collapsed diagnostics',
              'narrow panels, larger text, and three background surfaces',
              'aligned compact controls, matching ordinary row heights, color and shortcut popovers',
              'popover keyboard return, outside close, and recording cleanup',
              'new process with same profile starts at top'
            ]
          },
          null,
          2
        )
      )
      console.log('[settings-scroll] all checks passed, including a real application restart')
      app.exit(0)
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
} else {
  const profile = profileArg.slice('--scroll-profile='.length)
  app.setPath('userData', profile)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  if (phase === 'remember') {
    const db = new Database(join(profile, 'app.db'))
    db.exec(`CREATE TABLE app_settings (
      window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
      remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
      PRIMARY KEY (window_name,key))`)
    const put = db.prepare('INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)')
    for (const row of [
      ['application', 'application', 'active_view', 'list'],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ...['main', 'month', 'week'].map((scope) => [scope, 'system', 'blur_enabled', 'false'])
    ])
      put.run(...row)
    db.close()
  }
  let win
  const js = (code) => win.webContents.executeJavaScript(code)
  const body = "document.querySelector('.settings-panel .panel-body')"
  async function until(predicate, message) {
    const end = Date.now() + 10000
    while (Date.now() < end) {
      if (await predicate()) return
      await pause(25)
    }
    throw new Error(message)
  }
  async function view(mode) {
    const filename = mode === 'list' ? 'index' : mode
    if (win) await js(`window.api.switchMainView('${mode}')`)
    await until(() => {
      win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.getURL().endsWith(`/${filename}.html`)
      )
      return win
    }, `${mode} did not load`)
    await until(
      () => js("Boolean(document.querySelector('.titlebar-btn-settings'))"),
      'settings entry missing'
    )
  }
  async function open(expected, allowInitialClamp = false) {
    await js(`(() => {
      window.__scrollFrames=[];
      const observer=new MutationObserver(() => {
        if (!document.querySelector('.settings-panel.active')) return;
        observer.disconnect();
        const sample=()=>{window.__scrollFrames.push(${body}.scrollTop);if(window.__scrollFrames.length<12)requestAnimationFrame(sample)};
        requestAnimationFrame(sample);
      });
      observer.observe(document.body,{subtree:true,attributes:true,childList:true});
      document.querySelector('.titlebar-btn-settings').click();
    })()`)
    await until(() => js('window.__scrollFrames.length===12'), 'panel did not enter')
    const frames = await js('window.__scrollFrames')
    assert.ok(
      frames.every((top) =>
        allowInitialClamp ? top > 0 && top <= expected + 1 : Math.abs(top - expected) < 2
      ),
      `entrance jumped: expected ${expected}, got ${frames}`
    )
    await pause(400)
    assert.ok(
      Math.abs((await js(`${body}.scrollTop`)) - expected) < 2,
      'final scroll position did not restore'
    )
  }
  async function scroll(top) {
    return js(`(()=>{const el=${body};el.scrollTop=${top};return el.scrollTop})()`)
  }
  async function close(escape = false) {
    await js(
      escape
        ? "document.querySelector('.settings-panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
        : "document.querySelector('.panel-close-btn').click()"
    )
    await until(() => js("!document.querySelector('.settings-panel')"), 'panel did not close')
  }
  async function search(term) {
    await js(`(() => {
      const input = document.querySelector('.settings-search input');
      input.value = ${JSON.stringify(term)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await until(
      () => js("Boolean(document.querySelector('.settings-search-results button'))"),
      `search result missing: ${term}`
    )
  }
  async function checkLayout(mode) {
    const bounds = win.getBounds()
    const settings = await js(
      'window.api.getSettingsSnapshot().then(s => ({ font: s.values.css.fontSizeBase, size: s.values.ui.settingsPanelSize }))'
    )
    async function configure(font, size) {
      await scroll(0)
      await close()
      await js(`(async () => {
        await window.api.setSettingValue('css.fontSizeBase', ${font});
        await window.api.setSettingValue('ui.settingsPanelSize', ${size});
      })()`)
      await open(0)
    }
    win.setSize(mode === 'list' ? 480 : 1200, 820)
    await pause(160)
    const initial = await js(`(() => {
      const p = document.querySelector('.settings-panel');
      const label = p.querySelector('.setting-label');
      const root = document.documentElement;
      return {
        groups: [...p.querySelectorAll('.category-title')].map(n => n.textContent),
        bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
        settingsFont: parseFloat(getComputedStyle(label).fontSize),
        rootStyle: root.style.cssText,
        bodyStyle: document.body.style.cssText,
        expanded: p.querySelector('.diagnostics-toggle').getAttribute('aria-expanded')
      };
    })()`)
    assert.deepEqual(initial.groups, [
      '外观',
      '窗口与操作',
      '便签与截图',
      '天气与日历',
      '系统与数据'
    ])
    assert.ok(
      initial.settingsFont < initial.bodyFont * 0.9,
      'settings font was not reduced locally'
    )
    assert.ok(initial.settingsFont >= 12, 'settings text became too small')
    assert.equal(initial.expanded, 'false', 'diagnostics should start collapsed')
    await search('备注字号')
    assert.equal(
      await js("document.querySelector('.settings-search-results button').textContent.trim()"),
      '备注字号'
    )
    await js("document.querySelector('.settings-search-results button').click()")
    await until(
      () => js("document.activeElement.closest('.setting-item')?.textContent.includes('备注字号')"),
      'search did not focus the requested control'
    )
    await search('调度器诊断')
    await js("document.querySelector('.settings-search-results button').click()")
    await until(
      () =>
        js(
          "document.querySelector('.diagnostics-toggle').getAttribute('aria-expanded') === 'true' && Boolean(document.activeElement.closest('.diagnostics-content'))"
        ),
      'search did not reveal and focus diagnostics'
    )
    const savedTop = await js(`${body}.scrollTop`)
    await close()
    await open(savedTop, true)
    assert.equal(
      await js("document.querySelector('.diagnostics-toggle').getAttribute('aria-expanded')"),
      'true'
    )
    await js("document.querySelector('.diagnostics-toggle').click()")
    await pause(350)
    const captureDir = resolve('tmp/settings-layout')
    mkdirSync(captureDir, { recursive: true })
    const measurements = []
    for (const narrow of [false, true]) {
      win.setSize(mode === 'list' ? (narrow ? 360 : 480) : narrow ? 960 : 1200, 820)
      await configure(
        narrow ? (mode === 'list' ? 22 : 28) : mode === 'list' ? 17 : 20,
        mode === 'list' ? 70 : narrow ? 25 : 40
      )
      await pause(160)
      const dimensions = await js(`(() => {
        const p = document.querySelector('.settings-panel');
        const b = p.querySelector('.panel-body');
        const rows = [...p.querySelectorAll('.setting-item')].filter(n => n.getClientRects().length);
        return {
          mode: ${JSON.stringify(mode)}, narrow: ${narrow},
          width: p.getBoundingClientRect().width,
          font: getComputedStyle(p.querySelector('.setting-label')).fontSize,
          bodyOverflow: b.scrollWidth - b.clientWidth,
          rowOverflow: rows.filter(n => n.scrollWidth > n.clientWidth + 2).map(n => n.textContent.trim().slice(0, 70)),
          ordinaryRows: rows.filter(n => n.closest('[data-settings-category="appearance"]') && !n.querySelector('.wallpaper-settings, .setting-hint-caption, .setting-error')).map(n => {
            const label = n.querySelector('.setting-label');
            const control = n.querySelector('.setting-right, .titlebar-style-selector, .setting-slider-control');
            const r = n.getBoundingClientRect();
            return { label: label?.textContent.trim(), height: r.height, right: control?.getBoundingClientRect().right,
              sameLine: !!control && control.getBoundingClientRect().left >= label.getBoundingClientRect().right - 1 };
          }).filter(r => r.label),
          gutterDelta: p.querySelector('.settings-search input').getBoundingClientRect().left - p.querySelector('.category-title').getBoundingClientRect().left
        };
      })()`)
      measurements.push(dimensions)
      assert.ok(dimensions.bodyOverflow <= 2, JSON.stringify(dimensions))
      assert.deepEqual(dimensions.rowOverflow, [], JSON.stringify(dimensions))
      assert.ok(Math.abs(dimensions.gutterDelta) <= 1, 'search and content gutters should align')
      if (!narrow)
        assert.ok(
          dimensions.ordinaryRows.every((row) => row.sameLine),
          JSON.stringify(dimensions)
        )
      const rightEdges = dimensions.ordinaryRows.map((row) => row.right)
      if (!narrow)
        assert.ok(
          Math.max(...rightEdges) - Math.min(...rightEdges) < 2,
          'control right edges diverged'
        )
      if (!narrow) {
        const heights = dimensions.ordinaryRows.map((row) => row.height)
        assert.ok(Math.max(...heights) - Math.min(...heights) < 2, JSON.stringify(dimensions))
      }
      for (const theme of narrow ? ['white'] : ['white', 'black', 'wallpaper']) {
        await js(
          `document.documentElement.style.setProperty('--bg-color', '${theme === 'black' ? '0 0 0' : '255 255 255'}'); document.documentElement.style.setProperty('--text-color', '${theme === 'black' ? '#fff' : '#182333'}'); document.body.style.background = ${JSON.stringify(theme === 'wallpaper' ? 'repeating-linear-gradient(35deg,#b85b72 0 70px,#3b769c 70px 140px,#bda775 140px 210px)' : theme)}`
        )
        await pause(100)
        writeFileSync(
          join(captureDir, `${mode}-${narrow ? 'narrow' : 'normal'}-${theme}.png`),
          (await win.webContents.capturePage()).toPNG()
        )
        await js(`document.querySelector('.settings-color-control button').click()`)
        await until(
          () => js("Boolean(document.querySelector('.settings-control-panel'))"),
          'color popup missing'
        )
        await pause(250)
        const popup = await js(`(() => {
          const p = document.querySelector('.settings-control-panel'); const r = p.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight,
            overflow: p.scrollWidth - p.clientWidth, font: parseFloat(getComputedStyle(p).fontSize) };
        })()`)
        assert.ok(
          popup.left >= 0 &&
            popup.right <= popup.width &&
            popup.top >= 0 &&
            popup.bottom <= popup.height,
          JSON.stringify(popup)
        )
        assert.ok(
          popup.overflow <= 2 && popup.font >= 12 && popup.font <= 16,
          JSON.stringify(popup)
        )
        writeFileSync(
          join(captureDir, `${mode}-${narrow ? 'narrow' : 'normal'}-color-${theme}.png`),
          (await win.webContents.capturePage()).toPNG()
        )
        if (!narrow && theme === 'white') {
          const originalColor = await js(
            'window.api.getSettingsSnapshot().then(s => s.values.css.bgColor)'
          )
          await js(`(() => {
            const input = document.querySelector('.settings-control-panel .color-hex-input');
            input.focus(); input.value = '#123456';
            input.dispatchEvent(new Event('input', {bubbles:true}));
            input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
          })()`)
          await until(
            () =>
              js("window.api.getSettingsSnapshot().then(s => s.values.css.bgColor === '18 52 86')"),
            'color popup did not save typed value'
          )
          await js(`(() => {
            const input = document.querySelector('.settings-control-panel .color-hex-input');
            input.value = '#zzzzzz'; input.dispatchEvent(new Event('input', {bubbles:true}));
            input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
          })()`)
          assert.equal(
            await js("document.querySelector('.color-hex-input').classList.contains('has-error')"),
            true
          )
          assert.equal(
            await js('window.api.getSettingsSnapshot().then(s => s.values.css.bgColor)'),
            '18 52 86',
            'invalid input changed saved color'
          )
          await js(`document.querySelector('.settings-control-panel .color-dot').click()`)
          await until(
            () =>
              js("window.api.getSettingsSnapshot().then(s => s.values.css.bgColor === '0 0 0')"),
            'color preset did not save'
          )
          await js(`window.api.setSettingValue('css.bgColor', ${JSON.stringify(originalColor)})`)
        }
        await js(
          `document.querySelector('.settings-control-panel').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))`
        )
        await until(
          () => js("!document.querySelector('.settings-control-panel')"),
          'color popup did not close'
        )
        assert.equal(
          await js("document.activeElement.matches('.settings-color-control button')"),
          true,
          'Escape did not return focus'
        )
      }
      await js(`(() => {
        const trigger = document.querySelector('[data-shortcut="viewVisibility"] button');
        trigger.scrollIntoView({ block: 'center', behavior: 'instant' }); trigger.click();
      })()`)
      await until(
        () => js("Boolean(document.querySelector('.shortcut-recorder-field'))"),
        'shortcut popup missing'
      )
      await pause(250)
      writeFileSync(
        join(captureDir, `${mode}-${narrow ? 'narrow' : 'normal'}-shortcut.png`),
        (await win.webContents.capturePage()).toPNG()
      )
      await js("document.querySelector('.shortcut-recorder-field').click()")
      await until(
        () =>
          js(
            'window.api.getSettingsSnapshot().then(s => s.runtime.shortcuts.viewVisibility.capturing)'
          ),
        'recording did not begin'
      )
      await js(
        "document.querySelector('.panel-title').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))"
      )
      await until(
        () => js("!document.querySelector('.shortcut-recorder')"),
        'outside click did not close recorder'
      )
      await until(
        () =>
          js(
            'window.api.getSettingsSnapshot().then(s => !s.runtime.shortcuts.viewVisibility.capturing)'
          ),
        'closing popup leaked recording session'
      )
      await scroll(0)
    }
    for (const category of ['notes', 'weather', 'system']) {
      await js(`(() => {
        const p = document.querySelector('.settings-panel');
        const b = p.querySelector('.panel-body');
        const target = p.querySelector('[data-settings-category="${category}"]');
        b.scrollTop += target.getBoundingClientRect().top - b.getBoundingClientRect().top;
      })()`)
      await pause(100)
      const categoryLayout = await js(`(() => {
        const p = document.querySelector('.settings-panel');
        const target = p.querySelector('[data-settings-category="${category}"]');
        return { width: p.getBoundingClientRect().width, font: parseFloat(getComputedStyle(p.querySelector('.setting-label')).fontSize), overflow: target.scrollWidth - target.clientWidth };
      })()`)
      assert.ok(categoryLayout.overflow <= 2, `${category}: ${JSON.stringify(categoryLayout)}`)
      if (mode !== 'list') {
        assert.equal(categoryLayout.width, 300, 'narrow category capture width changed')
        assert.equal(categoryLayout.font, 16, 'large-text category capture font changed')
      }
      writeFileSync(
        join(captureDir, `${mode}-narrow-${category}.png`),
        (await win.webContents.capturePage()).toPNG()
      )
    }
    writeFileSync(join(captureDir, `${mode}.json`), JSON.stringify(measurements, null, 2))
    win.setBounds(bounds)
    await configure(settings.font, settings.size)
    await js(
      `document.documentElement.style.cssText = ${JSON.stringify(initial.rootStyle)}; document.body.style.cssText = ${JSON.stringify(initial.bodyStyle)}; ${body}.scrollTop = 0;`
    )
    await pause(160)
  }
  async function run() {
    const positions = new Map()
    for (const [index, mode] of ['list', 'month', 'week'].entries()) {
      await view(mode)
      await open(0)
      if (phase === 'restart') {
        assert.equal(
          await js("document.querySelector('.diagnostics-toggle').getAttribute('aria-expanded')"),
          'false'
        )
      }
      if (phase === 'remember') {
        await checkLayout(mode)
        const top = await scroll(420 + index * 300)
        assert.ok(top > 300)
        positions.set(mode, top)
        await close(index === 1)
        await open(top)
      }
      await close()
    }
    if (phase === 'remember') {
      for (const mode of ['list', 'month', 'week']) {
        await view(mode)
        await open(positions.get(mode))
        await close()
      }
      await view('list')
      await open(positions.get('list'))
      const bottom = await scroll(1_000_000)
      await close()
      await open(bottom, true)
      const top = await scroll(1300)
      await new Promise((done) => {
        win.webContents.once('did-finish-load', done)
        win.webContents.reload()
      })
      await until(
        () => js("Boolean(document.querySelector('.titlebar-btn-settings'))"),
        'reload did not mount'
      )
      await open(top)
      const styles = await js(
        '({root:document.documentElement.style.cssText,body:document.body.style.cssText})'
      )
      const captures = resolve('tmp/settings-scroll-memory')
      mkdirSync(captures, { recursive: true })
      for (const theme of ['white', 'black', 'wallpaper']) {
        await js(
          `document.documentElement.style.setProperty('--bg-color', '${theme === 'black' ? '0 0 0' : '255 255 255'}');document.documentElement.style.setProperty('--text-color','${theme === 'black' ? '#fff' : '#182333'}');document.body.style.background=${JSON.stringify(theme === 'wallpaper' ? 'repeating-linear-gradient(35deg,#b85b72 0 70px,#3b769c 70px 140px,#bda775 140px 210px)' : theme)}`
        )
        await pause(160)
        writeFileSync(join(captures, `${theme}.png`), (await win.webContents.capturePage()).toPNG())
      }
      await js(
        `document.documentElement.style.cssText=${JSON.stringify(styles.root)};document.body.style.cssText=${JSON.stringify(styles.body)}`
      )
      await js(
        `(()=>{const input=document.querySelector('.settings-search input');input.value='调度器诊断';input.dispatchEvent(new Event('input',{bubbles:true}))})()`
      )
      await until(
        () => js("Boolean(document.querySelector('.settings-search-results button'))"),
        'search result missing'
      )
      await js("document.querySelector('.settings-search-results button').click()")
      await pause(120)
      await close()
      const saved = await js("Number(sessionStorage.getItem('abandon-note:settings-scroll:list'))")
      await open(saved)
      await close()
    }
    console.log(`[settings-scroll] ${phase} passed`)
    app.exit(0)
  }
  setTimeout(() => {
    console.error('[settings-scroll] timed out')
    app.exit(1)
  }, 120000)
  app.once('ready', () => {
    void run().catch((error) => {
      console.error(error)
      app.exit(1)
    })
  })
  const require = createRequire(import.meta.url)
  require(resolve('out/main/index.js'))
  const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(chunk)
  require(resolve('out/main/chunks', chunk))
}
