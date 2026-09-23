import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { app, BrowserWindow, net, nativeImage } from 'electron'

// Keep Electron alive until asynchronous backend cleanup and explicit exit finish.
app.on('window-all-closed', () => {})

async function run() {
  const serverRoot = resolve(process.argv[2] || '../abandon_note_server_light')
  const qa = resolve('tmp/notice-markdown-qa')
  await mkdir(qa, { recursive: true })
  const child = spawn(
    resolve(serverRoot, '.venv/Scripts/python.exe'),
    [resolve('tests/fixtures/notice-admin-server.py'), serverRoot],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let output = ''
  child.stdout.on('data', (data) => {
    output += data.toString()
  })
  child.stderr.on('data', (data) => {
    output += data.toString()
  })
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  async function until(fn, label) {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const value = await fn()
      if (value) return value
      await wait(60)
    }
    throw new Error(label)
  }
  let server, window
  try {
    const port = await until(() => output.match(/NOTICE_QA_PORT=(\d+)/)?.[1], 'QA 后端未启动')
    const backend = `http://127.0.0.1:${port}`
    await until(async () => {
      try {
        return (await fetch(backend + '/api/v1/client/health')).ok
      } catch {
        return false
      }
    }, 'QA 后端未就绪')
    const adminRoot = resolve(serverRoot, 'web/dist')
    const previewRoot = resolve('tmp/notice-preview-dist')
    const mime = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.woff2': 'font/woff2',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.png': 'image/png'
    }
    server = createServer(async (req, res) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/media/')) {
        // Deliberately delay uploads to test editing and publish lock while pending.
        if (req.url === '/api/v1/notice/images') await wait(450)
        const proxy = httpRequest(
          backend + req.url,
          { method: req.method, headers: req.headers },
          (response) => {
            res.writeHead(response.statusCode, response.headers)
            response.pipe(res)
          }
        )
        proxy.on('error', () => {
          res.writeHead(502)
          res.end()
        })
        req.pipe(proxy)
        return
      }
      try {
        const pathname = decodeURIComponent(new URL(req.url, backend).pathname)
        const isPreview = pathname.startsWith('/notice-preview/')
        const base = isPreview ? previewRoot : adminRoot
        let path = resolve(
          base,
          '.' + (isPreview ? pathname.slice('/notice-preview'.length) : pathname)
        )
        assert.ok(path === base || path.startsWith(base + sep))
        if (!extname(path)) path = resolve(adminRoot, 'index.html')
        res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream')
        res.end(await readFile(path))
      } catch {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const origin = `http://127.0.0.1:${server.address().port}`
    await app.whenReady()
    window = new BrowserWindow({
      show: false,
      width: 1600,
      height: 1120,
      useContentSize: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
        offscreen: true
      }
    })
    await window.webContents.session.protocol.handle('https', (request) => {
      const url = new URL(request.url)
      if (url.hostname !== 'notice-images.test') return new Response('', { status: 404 })
      return net.fetch(backend + url.pathname, { bypassCustomProtocolHandlers: true })
    })
    const js = async (code) => {
      try {
        return await window.webContents.executeJavaScript(code)
      } catch (error) {
        console.error('QA expression failed:', code.slice(0, 350))
        throw error
      }
    }
    const click = (text) =>
      js(
        `(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b) throw Error('button missing'); b.click() })()`
      )
    const login = await (
      await fetch(backend + '/api/v1/base/access_token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'notice-qa', password: 'notice-qa-password' })
      })
    ).json()
    const token = login.data.access_token
    const headers = { token, 'content-type': 'application/json' }
    await window.loadURL(origin)
    await js(
      `localStorage.setItem('ACCESS_TOKEN', JSON.stringify({value:${JSON.stringify(token)},time:Date.now(),expire:null})); localStorage.setItem('REFRESH_TOKEN', JSON.stringify({value:${JSON.stringify(login.data.refresh_token)},time:Date.now(),expire:null}))`
    )
    await window.loadURL(origin + '/business/notice')
    await until(() => js(`document.body.textContent.includes('新建通知')`), '通知后台未显示')
    await click('新建通知')
    await until(
      () => js(`Boolean(document.querySelector('.markdown-source'))`),
      'Markdown 编辑器未显示'
    )
    const text =
      '## 图文通知\n\n支持 **实时预览**，记录每一份灵感。\n\n- 列表与月视图\n- 图片点击放大\n'
    await js(
      `(() => { const title=document.querySelector('.notice-composer .n-form-item input'); title.value='图文通知演示'; title.dispatchEvent(new Event('input',{bubbles:true})); const area=document.querySelector('.markdown-source'); area.value=${JSON.stringify(text)}; area.dispatchEvent(new Event('input',{bubbles:true})); area.focus(); area.setSelectionRange(area.value.length,area.value.length); area.dispatchEvent(new Event('select')) })()`
    )
    await until(
      () =>
        js(
          `document.querySelector('iframe')?.contentDocument?.querySelector('.notice-markdown h2')?.textContent === '图文通知'`
        ),
      '实时预览未同步'
    )
    const before = await (await fetch(backend + '/api/v1/notice/list', { headers })).json()
    assert.equal(before.data.length, 0, '预览不应创建通知')
    const key = async (keyCode) => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
      await wait(100)
    }
    const focusPreview = () =>
      js(`(() => {
      const area = document.querySelector('.markdown-source');
      area.focus(); area.setSelectionRange(2, 6); area.dispatchEvent(new Event('select'));
      const frame = document.querySelector('iframe');
      frame.contentWindow.focus();
      frame.contentDocument.querySelector('.app-modal-close').focus();
    })()`)
    for (const action of ['escape', 'close', 'acknowledge']) {
      await focusPreview()
      if (action === 'escape') {
        // The preview retains the client's modal Tab behavior, with a working Esc exit.
        await key('Tab')
        await key('Escape')
      } else {
        await js(`(() => {
          const d = document.querySelector('iframe').contentDocument;
          const button = ${action === 'close' ? "d.querySelector('.app-modal-close')" : "[...d.querySelectorAll('button')].find(b => b.textContent.trim() === '知道了')"};
          button.click();
        })()`)
      }
      await until(
        () => js(`document.activeElement === document.querySelector('.markdown-source')`),
        `预览退出没有返回编辑区：${action}`
      )
      assert.deepEqual(
        await js(
          `(() => { const a=document.querySelector('.markdown-source'); return [a.selectionStart,a.selectionEnd] })()`
        ),
        [2, 6],
        '退出预览后必须恢复编辑器选区'
      )
      assert.ok(
        await js(
          `Boolean(document.querySelector('iframe').contentDocument.querySelector('.notice-markdown'))`
        )
      )
    }
    await js(
      `(() => {const a=document.querySelector('.markdown-source');a.setSelectionRange(a.value.length,a.value.length);a.dispatchEvent(new Event('select'))})()`
    )
    const pixels = Buffer.alloc(600 * 260 * 4)
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 190
      pixels[i + 1] = 140
      pixels[i + 2] = 40
      pixels[i + 3] = 255
    }
    const png = nativeImage
      .createFromBitmap(pixels, { width: 600, height: 260 })
      .toPNG()
      .toString('base64')
    const paste = `(() => { const bytes=Uint8Array.from(atob(${JSON.stringify(png)}),c=>c.charCodeAt(0)); const dt=new DataTransfer(); dt.items.add(new File([bytes],'demo.png',{type:'image/png'})); document.querySelector('.markdown-source').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true})) })()`
    await js(paste)
    await until(
      () => js(`document.querySelector('.markdown-source').value.includes('upload-pending:')`),
      '粘贴没有开始上传'
    )
    assert.ok(
      await js(
        `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存草稿').disabled`
      )
    )
    await js(
      `(() => { const a=document.querySelector('.markdown-source'); a.value+=${JSON.stringify('\n上传时继续编辑的内容')}; a.dispatchEvent(new Event('input',{bubbles:true})); a.setSelectionRange(2,2); a.dispatchEvent(new Event('select')) })()`
    )
    await until(
      () =>
        js(
          `document.querySelector('.markdown-source').value.includes('https://notice-images.test/media/notices/') && !document.querySelector('.markdown-source').value.includes('upload-pending:')`
        ),
      '真实图片上传没有返回直链'
    )
    let savedBody = await js(`document.querySelector('.markdown-source').value`)
    assert.equal(
      await js(`document.querySelector('.markdown-source').selectionStart`),
      2,
      '上传完成后光标发生跳动'
    )
    assert.ok(savedBody.includes('上传时继续编辑的内容'), '上传结果覆盖了编辑内容')
    await until(
      () =>
        js(
          `document.querySelector('iframe').contentDocument.querySelector('.markdown-image img')?.naturalWidth === 600`
        ),
      '预览未加载服务器实际图片'
    )
    await js(
      `(() => { const f=document.querySelector('iframe'); f.contentWindow.focus(); f.contentDocument.querySelector('.markdown-image').focus(); f.contentDocument.querySelector('.markdown-image').click() })()`
    )
    await until(
      () =>
        js(
          `Boolean(document.querySelector('iframe').contentDocument.querySelector('.markdown-enlarged'))`
        ),
      '后台预览大图未打开'
    )
    await wait(150)
    await key('Escape')
    await until(
      () =>
        js(`!document.querySelector('iframe').contentDocument.querySelector('.markdown-enlarged')`),
      '第一次 Esc 必须关闭大图'
    )
    assert.equal(await js(`document.activeElement.tagName`), 'IFRAME')
    await key('Escape')
    await until(
      () => js(`document.activeElement === document.querySelector('.markdown-source')`),
      '关闭大图后第二次 Esc 必须返回编辑区'
    )
    await wait(500)
    await writeFile(resolve(qa, 'admin-list.png'), (await window.webContents.capturePage()).toPNG())
    await js(`document.querySelectorAll('.preview-controls .n-base-selection')[0].click()`)
    await until(
      () =>
        js(
          `[...document.querySelectorAll('.n-base-select-option')].some(e=>e.textContent.trim()==='月视图')`
        ),
      '视图菜单未出现'
    )
    await js(
      `[...document.querySelectorAll('.n-base-select-option')].find(e=>e.textContent.trim()==='月视图').click()`
    )
    await until(
      () =>
        js(
          `document.querySelector('iframe').contentDocument.documentElement.classList.contains('month-view')`
        ),
      '月视图未同步'
    )
    await focusPreview()
    await key('Escape')
    await until(
      () => js(`document.activeElement === document.querySelector('.markdown-source')`),
      '月视图 Esc 必须返回编辑区'
    )
    await wait(500)
    await writeFile(
      resolve(qa, 'admin-month.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    await click('保存草稿')
    await until(() => js(`!document.querySelector('.markdown-source')`), '草稿未保存')
    const after = await (await fetch(backend + '/api/v1/notice/list', { headers })).json()
    assert.equal(after.data.length, 1)
    assert.equal(after.data[0].body, savedBody)
    assert.equal(after.data[0].publish_status, 'draft')
    await click('编辑')
    await until(() => js(`Boolean(document.querySelector('.markdown-source'))`), '编辑草稿失败')
    assert.equal(await js(`document.querySelector('.markdown-source').value`), savedBody)
    for (const mode of ['picker', 'drop']) {
      await js(
        `(() => { const a=document.querySelector('.markdown-source'); a.focus(); a.setSelectionRange(a.value.length,a.value.length); a.dispatchEvent(new Event('select')); const dt=new DataTransfer(); for(let i=0;i<${mode === 'drop' ? 2 : 1};i++) dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png)}),c=>c.charCodeAt(0))],'extra'+i+'.png',{type:'image/png'})); if(${JSON.stringify(mode)}==='picker') { const p=document.querySelector('.markdown-editor input[type="file"]'); p.files=dt.files; p.dispatchEvent(new Event('change',{bubbles:true})); } else a.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true})); })()`
      )
      await until(
        () => js(`document.querySelector('.markdown-source').value.includes('upload-pending:')`),
        '选图或拖拽未触发上传'
      )
      await until(
        () =>
          js(
            `!document.querySelector('.markdown-source').value.includes('upload-pending:') && ![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存草稿').disabled`
          ),
        '批量上传未完成'
      )
    }
    savedBody = await js(`document.querySelector('.markdown-source').value`)
    assert.equal((savedBody.match(/!\[通知图片\]/g) || []).length, 4)
    assert.ok(
      await js(
        `(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存草稿'); return b.getBoundingClientRect().bottom <= innerHeight })()`
      ),
      '保存按钮超出可视区域'
    )
    await js(
      `(() => { const item=[...document.querySelectorAll('.notice-composer .n-form-item')].find(e=>e.querySelector('.n-form-item-label')?.textContent.trim().startsWith('状态')); item.scrollIntoView({block:'nearest'}); item.querySelector('.n-base-selection').click() })()`
    )
    await until(
      () =>
        js(
          `[...document.querySelectorAll('.n-base-select-option')].some(e=>e.textContent.trim()==='已发布')`
        ),
      '发布状态菜单未显示'
    )
    await js(
      `[...document.querySelectorAll('.n-base-select-option')].find(e=>e.textContent.trim()==='已发布').click()`
    )
    await click('保存并发布')
    await until(() => js(`!document.querySelector('.markdown-source')`), '测试通知发布失败')
    const published = await (await fetch(backend + '/api/v1/notice/list', { headers })).json()
    assert.equal(published.data[0].publish_status, 'published')
    const pull = await (
      await fetch(backend + '/api/v1/client/notices/pull', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cursor: 0, system: 'win11', app_version: '1.2.0' })
      })
    ).json()
    assert.equal(pull.events[0].notice.body, savedBody)
    console.log(
      'NOTICE_ADMIN_ELECTRON_OK: real auth/upload/public image, live list/month preview, pending upload lock, concurrent edit, draft reopen, publish/pull Markdown roundtrip'
    )
  } catch (error) {
    if (window && !window.isDestroyed()) {
      await writeFile(
        resolve(qa, 'admin-failure.png'),
        (await window.webContents.capturePage()).toPNG()
      )
      console.error(
        await window.webContents.executeJavaScript('document.body.innerText.slice(-1800)')
      )
    }
    console.error(error)
    console.error(output.slice(-1800))
    process.exitCode = 1
  } finally {
    window?.destroy()
    server?.close()
    child.stdin.end('stop\n')
    await Promise.race([new Promise((done) => child.once('exit', done)), wait(3000)])
    if (child.exitCode === null) child.kill()
    app.exit(process.exitCode || 0)
  }
}
run().catch((error) => {
  console.error(error)
  app.exit(1)
})
