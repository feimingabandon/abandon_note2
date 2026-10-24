import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
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
const draftAssets = new Map()
let draftStages = 0
let draftPreviews = 0
let draftThumbnails = 0
const q = JSON.stringify
const js = (code) => window.webContents.executeJavaScript(code)
// Run the product F3 renderer handler against the real preview DOM. Only the
// background new-note panel is substituted; no OS shortcut registration is used.
const actionBarPath = 'src/renderer/src/components/list/ActionBar.vue'
const { descriptor: actionBar } = parse(readFileSync(actionBarPath, 'utf8'), {
  filename: actionBarPath
})
const newNoteHandler = compileScript(actionBar, {
  id: 'preview-shortcut-probe'
}).scriptSetupAst.find(
  (node) => node.type === 'FunctionDeclaration' && node.id.name === 'openNewNote'
)
if (!newNoteHandler) throw new Error('Product openNewNote handler was not found')
const openNewNoteSource = actionBar.scriptSetup.content.slice(
  newNoteHandler.start,
  newNoteHandler.end
)
const probeNewNoteShortcut = () =>
  js(`(() => {
    const target = document.createElement('textarea');
    document.querySelector('.app-scene').append(target);
    const newButtonRef = { value: target };
    const newPanelRef = { value: { focus: () => target.focus() } };
    const phase = { value: 'open' }, mode = { value: 'new' };
    let warnings = 0;
    const showMessage = () => warnings++;
    ${openNewNoteSource}
    try {
      openNewNote();
      return {
        backgroundFocused: document.activeElement === target,
        previewFocused: Boolean(document.activeElement?.closest('.ipv-overlay')),
        warnings
      };
    } finally {
      target.remove();
    }
  })()`)
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
  ipcMain.handle('fixture:draft-stage', (_event, image) => {
    const bytes = Buffer.from(image.base64, 'base64')
    const asset = {
      assetId: 'draft-' + ++draftStages,
      ext: image.ext,
      name: image.name,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
    draftAssets.set(asset.assetId, { ...asset, bytes })
    return asset
  })
  ipcMain.handle('fixture:draft-thumbnail', (_event, { assetId }) => {
    draftThumbnails++
    const image = nativeImage.createFromBuffer(draftAssets.get(assetId).bytes)
    const dimensions = image.getSize()
    return { data: image.resize({ width: 8, height: 8 }).toDataURL(), ...dimensions }
  })
  ipcMain.handle('fixture:draft-preview', (_event, assetId) => {
    draftPreviews++
    const { bytes, ext, size, sha256 } = draftAssets.get(assetId)
    return { bytes, ext, size, sha256 }
  })
  ipcMain.handle('fixture:draft-release', (_event, ids) => {
    for (const id of ids) draftAssets.delete(id)
    return true
  })
  ipcMain.handle('fixture:draft-flush', () => ({ dirty: true, blocked: false, persisted: true }))
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
  // Thumbnail menus load the original; preview controls reuse their displayed
  // original. Real browser PNG conversion is checked without system writes.
  const contextMenu = (selector) =>
    js(`document.querySelector(${q(selector)}).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 150 }))`)
  const copied = () => js('window.fixture.clipboardSnapshot().copiedImages')
  const menuVisuals = []
  const initialRootStyle = await js("document.documentElement.getAttribute('style')")
  for (const [name, background, text] of [
    ['white', '#ffffff', '#191919'],
    ['black', '#000000', '#eeeeee'],
    ['wallpaper', 'linear-gradient(35deg, #b15e80, #285c96 40%, #dbc764 70%, #458f77)', '#191919']
  ]) {
    await js(`(() => {
      document.documentElement.style.setProperty('--bg-color', ${q(name === 'black' ? '#000000' : '#ffffff')});
      document.documentElement.style.setProperty('--text-color', ${q(text)});
      document.body.style.background = ${q(background)};
      document.querySelector('.ip-thumb__img').dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: innerWidth - 4, clientY: innerHeight - 4
      }));
    })()`)
    await until(
      () =>
        js(`(() => {
      const panel = document.querySelector('.image-copy-menu');
      return panel && getComputedStyle(panel).opacity === '1';
    })()`),
      'copy menu did not finish entering'
    )
    assert.equal(
      await js(`(() => {
      const rect = document.querySelector('.image-copy-menu').getBoundingClientRect();
      return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    })()`),
      true,
      'copy menu must stay inside viewport on ' + name
    )
    const file = 'image-copy-menu-' + name + '.png'
    writeFileSync(
      join(process.env.ABANDON_TEST_EVIDENCE_DIR || lifecycle.root, file),
      (await window.webContents.capturePage()).toPNG()
    )
    menuVisuals.push(file)
    await js(
      "document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}))"
    )
    await until(async () => !(await exists('.image-copy-menu')), 'Escape did not dismiss copy menu')
  }
  await js(
    `document.documentElement.setAttribute('style', ${q(initialRootStyle)}); document.body.style.background = ''`
  )
  const beforeCopyReads = reads.length
  await contextMenu('.ip-thumb__img')
  await until(() => exists('.image-copy-menu'), 'thumbnail copy menu did not open')
  await click('.image-copy-menu button')
  await until(async () => (await copied()).length === 1, 'thumbnail image copy did not finish')
  assert.equal(reads.length, beforeCopyReads + 1, 'thumbnail copy must read only its original')
  assert.deepEqual(
    (await copied())[0],
    {
      width: 64,
      height: 64,
      pixel: [50, 100, 140, 255],
      type: 'image/png'
    },
    'copied PNG must contain full-resolution original pixels'
  )
  await click('.ip-thumb__img')
  await previewSource('1/image-0.png')
  assert.equal(
    await exists('.ipv-overlay[role="dialog"][aria-modal="true"][aria-label="图片预览"]'),
    true,
    'image preview must expose its modal ownership to shortcut guards'
  )
  assert.deepEqual(
    await probeNewNoteShortcut(),
    { backgroundFocused: false, previewFocused: true, warnings: 1 },
    'new-note shortcut moved focus behind the active preview'
  )
  const beforePreviewCopyReads = reads.length
  await click('[title="放大"]')
  await click('[title="旋转"]')
  await click('[aria-label="复制图片"]')
  await until(async () => (await copied()).length === 2, 'preview copy button did not finish')
  assert.deepEqual(
    (await copied())[1],
    (await copied())[0],
    'preview transforms changed copied pixels'
  )
  assert.equal(reads.length, beforePreviewCopyReads, 'preview copy re-read its original')
  await contextMenu('.ipv-image')
  await until(() => exists('.image-copy-menu--preview'), 'preview copy menu did not open')
  await js(
    "document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}))"
  )
  await until(
    async () => !(await exists('.image-copy-menu--preview')),
    'preview menu did not dismiss'
  )
  assert.equal(await exists('.ipv-overlay'), true, 'menu Escape must preserve the image preview')
  await contextMenu('.ipv-image')
  await click('.image-copy-menu--preview button')
  await until(async () => (await copied()).length === 3, 'preview menu copy did not finish')
  await click('.ipv-btn--close')
  await closed()
  assert.deepEqual(
    await probeNewNoteShortcut(),
    { backgroundFocused: true, previewFocused: false, warnings: 0 },
    'closed image preview continued to block the new-note shortcut'
  )

  // A cancelled thumbnail read cannot copy the prior note after navigation.
  holding = true
  await contextMenu('.ip-thumb__img')
  await click('.image-copy-menu button')
  await until(() => heldReads.length === 1, 'thumbnail copy original did not start')
  await js('window.fixture.changeNote(2)')
  releaseReads()
  await ready(2)
  await until(
    () => js('!window.fixture.clipboardSnapshot().busy'),
    'cancelled copy did not release'
  )
  assert.equal((await copied()).length, 3, 'note change copied a stale image')
  await js('window.fixture.changeNote(1)')
  await ready(1)
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

  // While the first image is genuinely leaving, navigation records only the
  // newest target. The third original may be read only after that node leaves.
  await click('.ip-thumb__img')
  await previewSource('1/image-0.png')
  const transitionReads = reads.length
  await click('.ipv-nav--next')
  await until(
    () => js("document.querySelectorAll('.ipv-image').length === 2"),
    'image leave did not start'
  )
  await js(`(() => {
    const button = document.querySelector('.ipv-nav--next');
    button.click(); button.click();
  })()`)
  assert.equal(reads.length, transitionReads + 1, 'third original was prepared during a live leave')
  await until(() => reads.length === transitionReads + 2, 'latest queued navigation did not start')
  assert.equal(reads.at(-1), '1/image-0.png', 'rapid navigation did not retain the latest target')
  await previewSource('1/image-0.png')
  await click('.ipv-btn--close')
  await closed()

  // Note-only and legacy single-src consumers retain the same real SFC paths.
  await click('#note-preview')
  await previewSource('1/image-0.png')
  await click('.ipv-nav--next')
  await previewSource('1/image-1.png')
  await click('.ipv-btn--close')
  await closed()
  await js(`window.fixture.showLegacy(${q(originals.get('1/image-0.png'))})`)
  await previewSource('1/image-0.png')
  assert.equal(
    await js("document.activeElement === document.querySelector('.ipv-overlay')"),
    true,
    'preview did not acquire DOM focus'
  )
  await js(
    "document.querySelector('.ipv-overlay').dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))"
  )
  assert.equal(
    await js("document.activeElement === document.querySelector('.ipv-image')"),
    true,
    'Shift+Tab escaped preview focus'
  )
  await js(
    "document.querySelector('.ipv-overlay').dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',bubbles:true,cancelable:true}))"
  )
  assert.equal(
    await js("document.activeElement === document.querySelector('.ipv-btn')"),
    true,
    'Tab escaped preview focus'
  )
  await js(`(() => {
    const image = document.querySelector('.ipv-image');
    document.querySelector('.ipv-viewport').dispatchEvent(new WheelEvent('wheel', {deltaY:-1, bubbles:true, cancelable:true}));
    document.querySelector('[title="旋转"]').click();
    image.dispatchEvent(new MouseEvent('mousedown', {button:0, clientX:10, clientY:20, bubbles:true}));
    document.dispatchEvent(new MouseEvent('mousemove', {clientX:30, clientY:50, bubbles:true}));
  })()`)
  const transform = await js("document.querySelector('.ipv-image').style.transform")
  assert.equal(transform.includes('scale(1.1)'), true, 'wheel zoom was lost')
  assert.equal(transform.includes('rotate(90deg)'), true, 'rotation was lost')
  assert.equal(transform.includes('translate(20px, 30px)'), true, 'drag was lost')
  await js('window.fixture.queueProbe()')
  assert.equal(
    await js('window.fixture.snapshot().queued'),
    false,
    'preview failed to hold modal FIFO'
  )
  await js(
    `document.querySelector('.ipv-overlay').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}))`
  )
  await closed()
  await until(
    () => js('window.fixture.snapshot().queued'),
    'preview did not release modal FIFO after exit'
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

  const uploadedFile = fixtureImage(75, 25, 180, 64)
  await js(`(() => {
    const source = ${q(uploadedFile)};
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
  assert.equal(
    snapshot.thumbnails.includes(uploadedFile),
    false,
    'stored file retained its original'
  )
  const uploadedFileSelector = '.ip-thumb__img[alt="fixture-file.png"]'
  // Model loading can finish before the spinner's out-in transition mounts the
  // thumbnail. Await this file's actual node instead of clicking the previous last image.
  await until(
    () =>
      js(`(() => {
      const image = document.querySelector(${q(uploadedFileSelector)});
      return image?.complete && image.naturalWidth === 8;
    })()`),
    'stored file thumbnail did not mount'
  )
  await click(uploadedFileSelector)
  await previewSource('2/stored-2.png')
  assert.equal(reads.at(-1), '2/stored-2.png', 'stored file preview read the wrong image')
  await click('.ipv-btn--close')
  await closed()

  // The managed original keeps its encoded animation after preparation rather
  // than displaying the static thumbnail. Observe one existing tiny GIF only.
  const animated =
    'data:image/gif;base64,' +
    readFileSync(
      new URL('./fixtures/image-preview-budget/gif-restore-previous.gif', import.meta.url)
    ).toString('base64')
  originals.set('2/stored-2.png', animated)
  await click(uploadedFileSelector)
  await until(
    () =>
      js(`document.querySelector('.ipv-image')?.src === ${q(animated)} &&
      document.querySelector('.ipv-image').complete && document.querySelector('.ipv-image').naturalWidth === 3`),
    'animated original did not open'
  )
  assert.equal(reads.at(-1), '2/stored-2.png', 'animation preview read the wrong image')
  await until(
    () =>
      js(`(() => {
      const overlay = document.querySelector('.ipv-overlay');
      if (!overlay || overlay.querySelector('[class*="-enter-active"], [class*="-enter-from"]') ||
        overlay.matches('[class*="-enter-active"], [class*="-enter-from"]')) return false;
      return overlay.getAnimations({subtree:true}).every(animation =>
        animation.playState !== 'running' && !animation.pending);
    })()`),
    'animation preview CSS entrance did not finish'
  )
  // The owned isolation probe showed drawImage(img) returns one default frame
  // while capturePage observes three presented GIF frames. Observe the actual
  // image rectangle, with the same eight samples and cadence.
  const animationRectangle = await js(`(() => {
    const bounds = document.querySelector('.ipv-image').getBoundingClientRect();
    const x = Math.floor(bounds.x), y = Math.floor(bounds.y);
    return {x, y, width: Math.ceil(bounds.right) - x, height: Math.ceil(bounds.bottom) - y};
  })()`)
  const animatedSamples = { samples: [], sourceUnchanged: true }
  for (let index = 0; index < 8; index++) {
    const frame = await window.webContents.capturePage(animationRectangle)
    animatedSamples.samples.push(createHash('sha256').update(frame.toBitmap()).digest('hex'))
    animatedSamples.sourceUnchanged &&= await js(
      `document.querySelector('.ipv-image')?.src === ${q(animated)}`
    )
    await new Promise((done) => setTimeout(done, 80))
  }
  assert.equal(animatedSamples.sourceUnchanged, true, 'animation replaced its original source')
  assert.equal(
    new Set(animatedSamples.samples).size > 1,
    true,
    'original animation became a static frame'
  )
  await click('.ipv-btn--close')
  await closed()

  const draft = fixtureImage(150, 90, 30, 16)
  assert.equal(await js(`window.fixture.useDraft(${q(draft)})`), true, 'draft image was not added')
  await until(() => exists('.ip-thumb__img'), 'draft thumbnail missing')
  await click('.ip-thumb__img')
  await until(
    () =>
      js(
        "document.querySelector('.ipv-image')?.src.startsWith('blob:') && document.querySelector('.ipv-image').complete && document.querySelector('.ipv-image').naturalWidth === 16"
      ),
    'draft preview did not open'
  )
  assert.equal(
    await js('window.fixture.snapshot().activeBlobUrls'),
    1,
    'draft original lease missing'
  )
  const immediatelyAfterClose = await js(
    "(() => { document.querySelector('.ipv-btn--close').click(); return window.fixture.snapshot().activeBlobUrls })()"
  )
  assert.equal(immediatelyAfterClose, 1, 'close revoked a still-connected original')
  await closed()
  assert.equal(
    await js('window.fixture.snapshot().activeBlobUrls'),
    0,
    'closed draft retained a Blob URL'
  )
  assert.equal(
    await js('window.fixture.snapshot().draftImageCount'),
    1,
    'closing preview lost draft'
  )
  assert.equal(draftStages, 1, 'draft staging was not exercised')
  assert.equal(draftThumbnails, 1, 'draft thumbnail did not use the main preparation port')
  assert.equal(draftPreviews, 1, 'draft original was not read on demand')
  // Closing during PNG encoding must cancel the write, while its Blob lease
  // remains live until the encoding callback finishes.
  await click('.ip-thumb__img')
  await until(
    () =>
      js(
        "document.querySelector('.ipv-image')?.complete && document.querySelector('.ipv-image').naturalWidth === 16"
      ),
    'draft copy preview did not decode'
  )
  await js('window.fixture.holdCopyConversion()')
  await click('[aria-label="复制图片"]')
  await until(
    () => js('window.fixture.clipboardSnapshot().converting === 1'),
    'PNG conversion did not start'
  )
  const writesBeforeClose = (await copied()).length
  await click('.ipv-btn--close')
  await closed()
  assert.equal(
    await js('window.fixture.snapshot().activeBlobUrls'),
    1,
    'encoding lost its draft Blob lease'
  )
  await js('window.fixture.releaseCopyConversion()')
  await until(
    () => js('!window.fixture.clipboardSnapshot().busy'),
    'cancelled encoding did not settle'
  )
  assert.equal(
    (await copied()).length,
    writesBeforeClose,
    'closed preview wrote stale clipboard content'
  )
  assert.equal(
    await js('window.fixture.snapshot().activeBlobUrls'),
    0,
    'completed encoding retained its Blob lease'
  )
  // A clear may leave the parent and assetPort object alive. Its connected image
  // still owns the Blob until the actual overlay has been removed.
  await click('.ip-thumb__img')
  await until(
    () => js("Boolean(document.querySelector('.ipv-image')?.src.startsWith('blob:'))"),
    'draft reopen missing'
  )
  await js('window.fixture.clearImages()')
  await closed()
  const resourceSnapshot = await js('window.fixture.snapshot()')
  assert.equal(resourceSnapshot.activeBlobUrls, 0, 'clear retained a Blob URL')
  assert.equal(
    resourceSnapshot.revocations.every(({ connected }) => !connected),
    true,
    'a live image lost its Blob URL'
  )
  assert.equal(
    new Set(resourceSnapshot.revocations.map(({ url }) => url)).size,
    resourceSnapshot.revocations.length,
    'a Blob URL was revoked twice'
  )
  assert.equal(
    resourceSnapshot.maximumPreviewImages <= 2,
    true,
    'preview held more than two actual image nodes'
  )
  draftAssets.clear()
  await lifecycle.finish({
    completed: true,
    window,
    summary: {
      cycles: 10,
      originalReads: reads.length,
      durableUploads: saves,
      heldReads: heldReads.length,
      draftStages,
      draftThumbnails,
      draftPreviews,
      animatedSamples,
      menuVisuals,
      maximumPreviewImages: resourceSnapshot.maximumPreviewImages,
      cachedOriginals: await js('window.fixture.snapshot().cachedOriginals'),
      coverage: [
        'switch',
        'close-release',
        'late-read',
        'note-change',
        'unmount',
        'draft-preserved',
        'stored-capture-thumbnail',
        'stored-file-thumbnail',
        'actual-transition-admission',
        'blob-node-ack',
        'same-port-clear',
        'note-preview',
        'legacy-single-src',
        'zoom-rotate-drag',
        'modal-fifo',
        'new-note-modal-focus-guard'
      ],
      limitations: [
        'small synthetic images',
        'no RSS/GC budget',
        'no product main process',
        'no physical F3 input; real renderer handler with a fixture background textarea',
        'clipboard write mocked; no external application paste'
      ]
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
