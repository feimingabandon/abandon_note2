import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { join, resolve } from 'node:path'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { traceRendererExpressions } from './helpers/renderer-evidence.mjs'

// Independent real Chromium/SFC/IPC fixture. It does not import the product main
// process or touch user data, and verifies retained references rather than GC RSS.
const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/renderer-resource-lifetime-electron.mjs',
  mode: 'electron-component-fixture',
  prefix: 'abandon-renderer-resource-lifetime-',
  metadata: {
    productSfc: 'ImagePicker.vue + ImagePreview.vue',
    ipc: 'isolated-small-image-fixture',
    input: 'real-DOM-handler',
    memoryScope: 'component original references and live image DOM; no process-memory threshold'
  },
  timeoutMs: 90000
})
app.setPath('userData', lifecycle.root)
const assert = lifecycle.assert
const fixtureRoot = resolve('tests/fixtures/renderer-resource-lifetime')
const output = join(lifecycle.root, 'fixture-dist')
const reads = []
const heldReads = []
let holding = false
let window
const originals = new Map()
const thumbnails = new Map()
const storedByNote = new Map()
let saves = 0
const q = JSON.stringify
const js = (code) => window.webContents.executeJavaScript(code)
async function until(read, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(label)
}
const click = (selector) => js(`document.querySelector(${q(selector)}).click()`)
const exists = (selector) => js(`Boolean(document.querySelector(${q(selector)}))`)
function releaseReads() {
  holding = false
  for (const done of heldReads.splice(0)) done()
}
function fixtureImage(red, green, blue, size) {
  const pixels = Buffer.alloc(size * size * 4)
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = blue
    pixels[offset + 1] = green
    pixels[offset + 2] = red
    pixels[offset + 3] = 255
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size }).toDataURL()
}
async function ready(noteId = 1) {
  await until(() => js('Boolean(window.fixture)'), 'fixture did not mount')
  const expected = Array.from({ length: 3 }, (_, index) =>
    thumbnails.get(`${noteId}/image-${index}.png`)
  )
  await until(
    () =>
      js(`(() => {
      const expected = ${q(expected)};
      const snapshot = window.fixture.snapshot();
      const images = [...document.querySelectorAll('.ip-thumb__img')];
      return snapshot.imageCount === 3 && snapshot.storedPaths.every(path => path.startsWith('${noteId}/')) &&
        images.length === 3 && images.every(image => expected.includes(image.src) && image.complete && image.naturalWidth === 8);
    })()`),
    'target thumbnails did not finish loading and leaving transitions'
  )
}
async function previewSource(path) {
  const expected = originals.get(path)
  await until(
    () =>
      js(`Array.from(document.querySelectorAll('.ipv-image')).some(image =>
        image.src === ${q(expected)} && !image.closest('[aria-hidden="true"]') &&
        image.complete && image.naturalWidth === 64)`),
    'original did not decode: ' + path
  )
}
async function closed() {
  await until(() => js("!document.querySelector('.ipv-overlay')"), 'preview did not close')
  const sources = await js('Array.from(document.images, image => image.src)')
  assert.equal(
    sources.some((source) => [...originals.values()].includes(source)),
    false,
    'closed preview retained an original in live image DOM'
  )
  assert.equal(await js('window.fixture.snapshot().cachedOriginals'), 0, 'card cached an original')
}

async function run() {
  for (const noteId of [1, 2]) {
    storedByNote.set(noteId, [])
    for (let index = 0; index < 3; index++) {
      const path = `${noteId}/image-${index}.png`
      originals.set(path, fixtureImage(50 + index * 60, 50 + noteId * 50, 140, 64))
      thumbnails.set(path, fixtureImage(50 + index * 60, 50 + noteId * 50, 140, 8))
      storedByNote.get(noteId).push({ id: noteId * 10 + index, file_path: path, file_size: 512 })
    }
  }
  ipcMain.handle('fixture:images', (_event, noteId) => storedByNote.get(noteId))
  ipcMain.handle('fixture:thumbnail', (_event, path) => thumbnails.get(path))
  ipcMain.handle('fixture:save-images', (_event, { noteId, images }) =>
    images.map(({ base64 }) => {
      const path = `${noteId}/stored-${++saves}.png`
      const source = 'data:image/png;base64,' + base64
      originals.set(path, source)
      thumbnails.set(
        path,
        nativeImage.createFromDataURL(source).resize({ width: 8, height: 8 }).toDataURL()
      )
      const record = {
        id: 1000 + saves,
        file_path: path,
        file_size: Buffer.from(base64, 'base64').length
      }
      storedByNote.get(noteId).push(record)
      return record
    })
  )
  ipcMain.handle('fixture:original', async (_event, path) => {
    reads.push(path)
    if (holding) await new Promise((done) => heldReads.push(done))
    return originals.get(path)
  })
  await build({
    configFile: false,
    root: fixtureRoot,
    base: './',
    plugins: [vue()],
    logLevel: 'error',
    build: { outDir: output, emptyOutDir: false }
  })
  window = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'Image preview resource lifetime',
    webPreferences: {
      preload: join(fixtureRoot, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  traceRendererExpressions(window, 'renderer-resource-lifetime')
  await window.loadFile(join(output, 'index.html'))
  await ready()
  const initialThumbnails = await js('window.fixture.snapshot().thumbnails')
  for (let cycle = 0; cycle < 10; cycle++) {
    await click('.ip-thumb__img')
    await previewSource('1/image-0.png')
    await click('.ipv-nav--next')
    await previewSource('1/image-1.png')
    await click('.ipv-btn--close')
    await closed()
  }
  assert.deepEqual(
    await js('window.fixture.snapshot().thumbnails'),
    initialThumbnails,
    'preview changed card thumbnails'
  )

  // Read one image slowly, navigate again, then close before IPC returns.
  await click('.ip-thumb__img')
  await previewSource('1/image-0.png')
  holding = true
  const beforeNavigation = reads.length
  await click('.ipv-nav--next')
  await until(() => heldReads.length === 1, 'navigation original did not start')
  await click('.ipv-nav--next')
  assert.equal(reads.length, beforeNavigation + 1, 'rapid navigation started another original read')
  await click('.ipv-btn--close')
  releaseReads()
  await closed()
  await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
  assert.equal(await exists('.ipv-overlay'), false, 'late navigation reopened the preview')
  assert.equal(reads.length, beforeNavigation + 1, 'closed navigation continued queued reads')

  // A parent may disappear or switch note while the first original is loading.
  for (const action of ['unmount', 'note-change']) {
    holding = true
    await click('.ip-thumb__img')
    await until(() => heldReads.length === 1, 'initial original did not start')
    if (action === 'unmount') await js('window.fixture.setMounted(false)')
    else await js('window.fixture.changeNote(2)')
    releaseReads()
    if (action === 'unmount') await js('window.fixture.setMounted(true)')
    await ready(action === 'note-change' ? 2 : 1)
    await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
    await closed()
  }
  await click('.ip-thumb__img')
  await previewSource('2/image-0.png')
  await click('.ipv-btn--close')
  await closed()

  // Exercise both persistent save entry points with the actual SFC and IPC.
  const uploaded = fixtureImage(25, 180, 75, 64)
  assert.equal(await js(`window.fixture.addStored(${q(uploaded)})`), true, 'stored capture failed')
  let snapshot = await js('window.fixture.snapshot()')
  assert.equal(snapshot.storedPaths.includes('2/stored-1.png'), true, 'stored upload lost its path')
  assert.equal(
    snapshot.thumbnails.includes(uploaded),
    false,
    'stored capture retained its original'
  )
  await js("Array.from(document.querySelectorAll('.ip-thumb__img')).at(-1).click()")
  await previewSource('2/stored-1.png')
  await click('.ipv-btn--close')
  await closed()

  await js(`(() => {
    const source = ${q(uploaded)};
    const bytes = Uint8Array.from(atob(source.split(',')[1]), char => char.charCodeAt(0));
    const files = new DataTransfer();
    files.items.add(new File([bytes], 'fixture-file.png', {type:'image/png'}));
    const input = document.querySelector('.ip-input');
    input.files = files.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
  })()`)
  await until(
    () => js('window.fixture.snapshot().imageCount === 5 && !window.fixture.snapshot().busy'),
    'file upload did not finish'
  )
  snapshot = await js('window.fixture.snapshot()')
  assert.equal(snapshot.storedPaths.includes('2/stored-2.png'), true, 'stored file lost its path')
  assert.equal(snapshot.thumbnails.includes(uploaded), false, 'stored file retained its original')
  await js("Array.from(document.querySelectorAll('.ip-thumb__img')).at(-1).click()")
  await previewSource('2/stored-2.png')
  await click('.ipv-btn--close')
  await closed()

  const draft = fixtureImage(150, 90, 30, 16)
  assert.equal(await js(`window.fixture.useDraft(${q(draft)})`), true, 'draft image was not added')
  await until(() => exists('.ip-thumb__img'), 'draft thumbnail missing')
  await click('.ip-thumb__img')
  await until(
    () => js(`document.querySelector('.ipv-image')?.src === ${q(draft)}`),
    'draft preview did not open'
  )
  await click('.ipv-btn--close')
  await closed()
  assert.equal(
    await js('window.fixture.snapshot().draftImageCount'),
    1,
    'closing preview lost draft'
  )
  await lifecycle.finish({
    completed: true,
    window,
    summary: {
      cycles: 10,
      originalReads: reads.length,
      durableUploads: saves,
      heldReads: heldReads.length,
      cachedOriginals: await js('window.fixture.snapshot().cachedOriginals'),
      coverage: [
        'switch',
        'close-release',
        'late-read',
        'note-change',
        'unmount',
        'draft-preserved',
        'stored-capture-thumbnail',
        'stored-file-thumbnail'
      ],
      limitations: ['small synthetic images', 'no RSS/GC budget', 'no product main process']
    },
    restore: releaseReads
  })
}

void app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error(error)
    void lifecycle.finish({ error, window, restore: releaseReads })
  })
