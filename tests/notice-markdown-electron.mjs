import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { app, BrowserWindow, nativeImage } from 'electron'

async function run() {
  const root = resolve('tmp/notice-preview-dist')
  const qa = resolve('tmp/notice-markdown-qa')
  await mkdir(qa, { recursive: true })
  const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.woff2': 'font/woff2'
  }
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname)
      assert.ok(path.startsWith(root + sep))
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream')
      res.end(await readFile(path))
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  async function until(fn, label) {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const value = await fn()
      if (value) return value
      await wait(40)
    }
    throw new Error(label)
  }
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    width: 480,
    height: 720,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      offscreen: true
    }
  })
  const evalJs = (code) => window.webContents.executeJavaScript(code)
  const pixels = Buffer.alloc(600 * 240 * 4)
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 210
    pixels[i + 1] = 150
    pixels[i + 2] = 35
    pixels[i + 3] = 255
  }
  const png = nativeImage.createFromBitmap(pixels, { width: 600, height: 240 }).toPNG()
  await window.webContents.session.protocol.handle('https', (request) => {
    if (request.url === 'https://images.example/feature.png')
      return new Response(png, { headers: { 'Content-Type': 'image/png' } })
    return new Response('', { status: 404 })
  })
  let opened = null
  window.webContents.setWindowOpenHandler(({ url }) => {
    opened = url
    return { action: 'deny' }
  })
  const body = `## 新版本功能\n\n支持 **Markdown 通知**、*实时预览*和图片展示。\n换行也会保留。\n\n![月视图演示](https://images.example/feature.png)\n\n- 月视图\n- 列表视图\n\n> 你的记录，清楚可见。\n\n[查看说明](https://example.com/docs)\n\n| 功能 | 状态 |\n|---|---|\n| 图片预览 | 已支持 |\n\n<script>window.noticeInjected = true</script>`
  async function update(payload) {
    await evalJs(
      `window.postMessage({type:'abandon-notice-preview', payload:${JSON.stringify(payload)}}, location.origin)`
    )
    await wait(200)
  }
  try {
    await window.loadURL(origin + '/index.html')
    await until(
      () => evalJs(`Boolean(document.querySelector('.notice-markdown'))`),
      'Markdown 未挂载'
    )
    await update({ body: '一行通知' })
    assert.equal(
      await evalJs(`getComputedStyle(document.querySelector('.notice-body')).minHeight`),
      '150px',
      '短通知必须保留父组件定义的最小高度'
    )
    assert.equal(
      await evalJs(`getComputedStyle(document.querySelector('.notice-markdown p')).marginBottom`),
      '0px',
      '单段正文末尾不应留下额外段落间距'
    )
    await update({ title: '更新你的记录方式', body })
    await until(
      () => evalJs(`document.querySelector('.markdown-image img')?.naturalWidth === 600`),
      'HTTPS 图片没有加载'
    )
    await evalJs('document.fonts.ready')
    await until(
      () =>
        evalJs(`document.querySelector('.markdown-image img').getBoundingClientRect().height > 50`),
      '图片加载后布局不可见'
    )
    assert.equal(await evalJs('Boolean(window.noticeInjected)'), false)
    assert.equal(
      await evalJs(`document.querySelector('.notice-markdown h2').textContent`),
      '新版本功能'
    )
    assert.equal(
      await evalJs(`getComputedStyle(document.querySelector('.notice-markdown ul')).listStyleType`),
      'disc'
    )
    assert.ok(
      await evalJs(
        `(() => {const b=document.querySelector('.app-modal-body'); return b.scrollWidth <= b.clientWidth + 1 && b.scrollHeight > b.clientHeight})()`
      )
    )
    for (const view of ['list', 'month']) {
      window.setContentSize(view === 'list' ? 480 : 1440, view === 'list' ? 720 : 900)
      for (const theme of ['light', 'dark', 'wallpaper']) {
        await update({ view, theme })
        await wait(250)
        assert.ok(
          await evalJs(
            `(() => { const img=document.querySelector('.markdown-image img'); const b=document.querySelector('.app-modal-body'); return img.getBoundingClientRect().width <= b.clientWidth })()`
          )
        )
        await writeFile(
          resolve(qa, `${view}-${theme}.png`),
          (await window.webContents.capturePage()).toPNG()
        )
      }
    }
    await evalJs(`document.querySelector('.markdown-image').click()`)
    await until(
      () => evalJs(`Boolean(document.querySelector('[aria-label="图片预览"] .markdown-enlarged'))`),
      '图片放大未打开'
    )
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await until(
      () => evalJs(`!document.querySelector('.markdown-enlarged')`),
      'Escape 没有关闭图片预览'
    )
    assert.ok(await evalJs(`Boolean(document.querySelector('[aria-label="软件通知"]'))`))
    await evalJs(`document.querySelector('[aria-label="软件通知"]').parentElement.click()`)
    assert.ok(
      await evalJs(`Boolean(document.querySelector('[aria-label="软件通知"]'))`),
      '点击通知弹窗遮罩空白处不应关闭'
    )
    await evalJs(`document.querySelector('[aria-label="软件通知"]').focus()`)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await wait(100)
    assert.ok(
      await evalJs(`Boolean(document.querySelector('[aria-label="软件通知"]'))`),
      '软件通知弹窗不应被 Escape 关闭'
    )
    await evalJs(`document.querySelector('.notice-markdown a[href]').click()`)
    await until(() => opened === 'https://example.com/docs', 'Markdown 链接没有经过外部浏览器处理')
    await update({ body: '![失效图片](https://images.example/missing.png)' })
    await until(
      () => evalJs(`document.querySelector('.markdown-image')?.disabled === true`),
      '图片失败状态未显示'
    )
    assert.ok(await evalJs(`!document.querySelector('.markdown-image-error').hidden`))
    await evalJs(`
      window.noticePreviewExitCount = 0
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'abandon-notice-preview-exit') window.noticePreviewExitCount += 1
      })
    `)
    await evalJs(`document.querySelector('[aria-label="软件通知"] .app-modal-close').click()`)
    await until(
      () => evalJs(`window.noticePreviewExitCount === 1`),
      '右上角 X 没有发出软件通知关闭请求'
    )
    await update({ body, kind: 'update', theme: 'light' })
    await until(
      () =>
        evalJs(
          `Boolean(document.querySelector('.release-notes .notice-markdown img')?.naturalWidth)`
        ),
      '更新说明图片未显示'
    )
    for (const theme of ['light', 'dark', 'wallpaper']) {
      await update({ theme })
      assert.ok(
        await evalJs(`(() => {
          const content = document.querySelector('.release-notes .notice-markdown');
          const probe = document.createElement('div');
          probe.style.cssText = 'font-size:var(--fs-secondary);color:var(--text-color-secondary);line-height:1.6';
          content.parentElement.append(probe);
          const actual = getComputedStyle(content), expected = getComputedStyle(probe);
          const correct = ['fontSize','color','lineHeight'].every(key => actual[key] === expected[key]);
          probe.remove();
          return correct;
        })()`),
        `更新正文必须继承父组件的字号、颜色和行高：${theme}`
      )
      await writeFile(
        resolve(qa, `update-${theme}.png`),
        (await window.webContents.capturePage()).toPNG()
      )
    }
    await writeFile(resolve(qa, 'update.png'), (await window.webContents.capturePage()).toPNG())
    console.log(
      'NOTICE_MARKDOWN_ELECTRON_OK: list/month, 3 backgrounds, HTTPS image, notification close policy, zoom/Escape, overflow, links, XSS, failure, independent update UI'
    )
  } catch (error) {
    console.error(error)
    try {
      await writeFile(resolve(qa, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    } catch (captureError) {
      console.error('Failure screenshot unavailable:', captureError)
    }
    process.exitCode = 1
  } finally {
    window.destroy()
    server.close()
    app.exit(process.exitCode || 0)
  }
}
run().catch((error) => {
  console.error(error)
  app.exit(1)
})
