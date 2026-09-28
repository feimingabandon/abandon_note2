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
  async function run() {
    const positions = new Map()
    for (const [index, mode] of ['list', 'month', 'week'].entries()) {
      await view(mode)
      await open(0)
      if (phase === 'remember') {
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
  }, 60000)
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
