import { app, BrowserWindow, ipcMain } from 'electron'
import { resolve } from 'node:path'
import { rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { createMainWindowHost } from '../src/main/windows/main-window-host.js'
import { createMainWindowIpc } from '../src/main/ipc/ipc-authorization.js'
import { registerAppIpc } from '../src/main/ipc/register-app-ipc.js'
import { registerRemoteNoticeIpc } from '../src/main/ipc/register-remote-notice-ipc.js'
import { registerWallpaperIpc } from '../src/main/ipc/register-wallpaper-ipc.js'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import {
  acknowledgeRemoteNotice,
  applyRemoteNoticeEvents,
  getRemoteNoticeLink,
  listPendingRemoteNotices,
  listRemoteNotices
} from '../src/main/db/db-remote-notices.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/app-ipc-electron.mjs',
  mode: 'electron-real-preload-app-ipc-authorization',
  metadata: {
    browserWindow: true,
    actualPreload: true,
    productionRegistrars: ['app', 'remote-notice', 'wallpaper'],
    updates: 'controlled-service-no-network',
    remoteNotices: 'real-repository-and-memory-sqlite-no-network',
    remoteHealth: 'controlled-cache-no-network',
    wallpaper: 'controlled-coordinator-and-image-read-ports',
    realWallpaperFileStorage: false,
    realWallpaperDecode: false,
    realMainComposition: false,
    hostReplacementAuthorization: true
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-app-ipc-' })
app.setPath('userData', profile.directory)
let completed = false
let failure = null
const host = createMainWindowHost({ BrowserWindow })
let updateCalls = 0
const opened = []
let dispose = () => {}
let disposeRemoteNotices = () => {}
let disposeWallpapers = () => {}
let remoteDatabase = null
let currentRemoteCoordinator = null
const transportCalls = []
const wallpaperLibrary = [{ id: 90, title: 'controlled existing wallpaper' }]
const wallpaperSettings = { enabled: false, activeId: null }
const wallpaperCrop = 'data:image/png;base64,controlled-crop'
const wallpaperOriginal = 'data:image/png;base64,controlled-original'
const wallpaperThumbnail = 'data:image/png;base64,controlled-thumbnail'
const transportInvocations = [
  'window.api.listPendingRemoteNotices()',
  'window.api.listRemoteNotices({limit:1,offset:1})',
  'window.api.acknowledgeRemoteNotice(1)',
  'window.api.openRemoteNoticeLink(1)',
  'window.api.getRemoteHealth()',
  'window.api.listWallpapers()',
  'window.api.getWallpaperThumbnail(90,260)',
  'window.api.getWallpaperData(90,true)',
  'window.api.saveWallpaper({cropped:{base64:"fixture"}})',
  'window.api.activateWallpaper(90)',
  'window.api.disableWallpaper()',
  'window.api.deleteWallpaper(90)'
]
const options = {
  show: false,
  webPreferences: {
    preload: resolve('out/preload/index.js'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false
  }
}
const page = { type: 'url', value: 'data:text/html,<html><body>IPC contract</body></html>' }

async function run() {
  try {
    remoteDatabase = new Database(':memory:')
    createDatabaseSchema(remoteDatabase)
    setDb(remoteDatabase)
    applyRemoteNoticeEvents(
      'transport-test',
      [
        {
          type: 'upsert',
          sequence: 1,
          noticeId: 'https',
          notice: {
            title: 'HTTPS notice',
            body: 'Local notice body',
            link: 'https://NOTICE.invalid/path',
            publishedAt: 10
          }
        },
        {
          type: 'upsert',
          sequence: 2,
          noticeId: 'http',
          notice: {
            title: 'HTTP notice',
            body: 'Local notice body',
            link: 'http://notice.invalid/refused',
            publishedAt: 20
          }
        }
      ],
      2
    )
    dispose = registerAppIpc({
      mainWindowIpc: createMainWindowIpc(ipcMain, host.getWindow),
      removeHandler: (channel) => ipcMain.removeHandler(channel),
      app,
      shell: {
        openExternal: async (url) => {
          opened.push(url)
        }
      },
      appUpdateService: {
        check: async () => {
          updateCalls++
          return { state: 'current', version: '2.0.0' }
        },
        getExternalUrl: ({ target, identity }) => {
          if (identity !== 'checked-release') throw new Error('更新身份失效')
          return 'https://example.invalid/' + target
        }
      }
    })
    disposeRemoteNotices = registerRemoteNoticeIpc({
      mainWindowIpc: createMainWindowIpc(ipcMain, host.getWindow),
      removeHandler: (channel) => ipcMain.removeHandler(channel),
      listPendingRemoteNotices: () => {
        transportCalls.push(['remote:pending'])
        return listPendingRemoteNotices()
      },
      listRemoteNotices: (query) => {
        transportCalls.push(['remote:list', query])
        return listRemoteNotices(query)
      },
      acknowledgeRemoteNotice: (id) => {
        transportCalls.push(['remote:acknowledge', id])
        return acknowledgeRemoteNotice(id)
      },
      getRemoteNoticeLink: (id) => {
        transportCalls.push(['remote:link', id])
        return getRemoteNoticeLink(id)
      },
      getRemoteCoordinator: () => {
        transportCalls.push(['remote:health'])
        return currentRemoteCoordinator
      },
      shell: { openExternal: async (url) => opened.push(url) }
    })
    disposeWallpapers = registerWallpaperIpc({
      mainWindowIpc: createMainWindowIpc(ipcMain, host.getWindow),
      removeHandler: (channel) => ipcMain.removeHandler(channel),
      backgroundSettingsCoordinator: {
        listWallpaperLibraryRecords: () => {
          transportCalls.push(['wallpaper:list'])
          return wallpaperLibrary.map((record) => ({ ...record }))
        },
        saveWallpaper: async (payload) => {
          transportCalls.push(['wallpaper:save', payload])
          if (!payload?.cropped) throw new Error('Controlled wallpaper crop missing')
          const record = { id: 91, title: 'controlled saved wallpaper' }
          wallpaperLibrary.push(record)
          return record
        },
        activateWallpaper: (payload) => {
          transportCalls.push(['wallpaper:activate', payload])
          const record = wallpaperLibrary.find((entry) => entry.id === payload?.id)
          if (!record) throw new Error('Controlled wallpaper not found')
          Object.assign(wallpaperSettings, { enabled: true, activeId: record.id })
          return { record, snapshot: { wallpaper: { ...wallpaperSettings } } }
        },
        disableWallpaper: () => {
          transportCalls.push(['wallpaper:disable'])
          wallpaperSettings.enabled = false
          return { wallpaper: { ...wallpaperSettings } }
        },
        deleteWallpaper: async (payload) => {
          transportCalls.push(['wallpaper:delete', payload])
          const index = wallpaperLibrary.findIndex((entry) => entry.id === payload?.id)
          if (index < 0) return false
          wallpaperLibrary.splice(index, 1)
          return true
        }
      },
      getWallpaperThumbnail: (id, maxSize) => {
        transportCalls.push(['wallpaper:thumbnail', id, maxSize])
        return wallpaperLibrary.some((entry) => entry.id === id) ? wallpaperThumbnail : null
      },
      getWallpaperDataUrl: async (id, selection) => {
        transportCalls.push(['wallpaper:data', id, selection])
        if (!wallpaperLibrary.some((entry) => entry.id === id)) return null
        return selection.original ? wallpaperOriginal : wallpaperCrop
      }
    })
    const window = host.create(options)
    host.installClosedCleanup(window, () => {})
    await host.load(window, page)
    const outsider = new BrowserWindow(options)
    await outsider.loadURL(page.value)
    const js = (code) => window.webContents.executeJavaScript(code)
    const other = (code) => outsider.webContents.executeJavaScript(code)
    assert.equal(await js('typeof require'), 'undefined')
    assert.equal(await js('typeof window.api.getAppInfo'), 'function')
    assert.deepEqual(await js('window.api.getAppInfo()'), {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch
    })
    assert.deepEqual(await js('window.api.checkForUpdate()'), {
      state: 'current',
      version: '2.0.0'
    })
    await assert.rejects(other('window.api.getAppInfo()'), /无权访问/)
    await assert.rejects(other('window.api.checkForUpdate()'), /无权访问/)
    assert.equal(updateCalls, 1)
    await assert.rejects(js("window.api.openUpdateLink({ target: 'file' })"), /未知的更新入口/)
    await assert.rejects(
      js("window.api.openUpdateLink({ target: 'github', identity: 'stale' })"),
      /更新身份失效/
    )
    assert.equal(opened.length, 0)
    assert.equal(
      await js("window.api.openUpdateLink({ target: 'github', identity: 'checked-release' })"),
      true
    )
    assert.deepEqual(opened, ['https://example.invalid/github'])

    // These requests cross the real sandboxed preload. Notice SQL is in-memory;
    // wallpaper image reads and complete commands are explicit controlled ports.
    const beforeOutsider = {
      calls: structuredClone(transportCalls),
      notices: remoteDatabase.prepare('SELECT * FROM remote_notices ORDER BY id').all(),
      library: structuredClone(wallpaperLibrary),
      settings: { ...wallpaperSettings },
      opened: [...opened]
    }
    for (const code of transportInvocations) await assert.rejects(other(code), /无权访问/)
    assert.deepEqual(transportCalls, beforeOutsider.calls)
    assert.deepEqual(
      remoteDatabase.prepare('SELECT * FROM remote_notices ORDER BY id').all(),
      beforeOutsider.notices
    )
    assert.deepEqual(wallpaperLibrary, beforeOutsider.library)
    assert.deepEqual(wallpaperSettings, beforeOutsider.settings)
    assert.deepEqual(opened, beforeOutsider.opened)

    assert.deepEqual(
      (await js('window.api.listPendingRemoteNotices()')).map(({ id }) => id),
      [1, 2]
    )
    const noticePage = await js('window.api.listRemoteNotices({limit:1,offset:1})')
    assert.deepEqual(
      {
        ids: noticePage.items.map(({ id }) => id),
        total: noticePage.total,
        pending: noticePage.pending,
        limit: noticePage.limit,
        offset: noticePage.offset
      },
      { ids: [1], total: 2, pending: 2, limit: 1, offset: 1 }
    )
    assert.deepEqual(transportCalls.at(-1), ['remote:list', { limit: 1, offset: 1 }])
    await assert.rejects(js('window.api.acknowledgeRemoteNotice(-1)'), /通知 ID 无效/)
    assert.equal(
      remoteDatabase
        .prepare('SELECT COUNT(*) AS count FROM remote_notices WHERE acknowledged_at IS NOT NULL')
        .get().count,
      0
    )
    assert.equal(await js('window.api.acknowledgeRemoteNotice(1)'), true)
    assert.deepEqual(transportCalls.at(-1), ['remote:acknowledge', 1])
    assert.deepEqual(
      (await js('window.api.listPendingRemoteNotices()')).map(({ id }) => id),
      [2]
    )
    assert.equal(await js('window.api.openRemoteNoticeLink(1)'), true)
    assert.deepEqual(opened, ['https://example.invalid/github', 'https://notice.invalid/path'])
    assert.equal(await js('window.api.openRemoteNoticeLink(2)'), false)
    assert.equal(await js('window.api.openRemoteNoticeLink(-1)'), false)
    assert.equal(opened.length, 2)
    assert.deepEqual(await js('window.api.getRemoteHealth()'), {
      available: false,
      noticeService: false,
      reportService: false,
      checkedAt: null,
      checking: false,
      skipped: false,
      error: '远程服务尚未初始化'
    })
    const cachedHealth = { available: true, checkedAt: 123, checking: false }
    let healthReads = 0
    currentRemoteCoordinator = {
      getHealthSnapshot: () => {
        healthReads++
        return { ...cachedHealth }
      },
      start: () => assert.fail('health IPC started remote service')
    }
    assert.deepEqual(await js('window.api.getRemoteHealth()'), cachedHealth)
    assert.deepEqual(await js('window.api.getRemoteHealth()'), cachedHealth)
    assert.equal(healthReads, 2)

    assert.deepEqual(await js('window.api.listWallpapers()'), [
      { id: 90, title: 'controlled existing wallpaper' }
    ])
    assert.equal(await js('window.api.getWallpaperThumbnail(90,260)'), wallpaperThumbnail)
    assert.deepEqual(transportCalls.at(-1), ['wallpaper:thumbnail', 90, 260])
    assert.equal(await js('window.api.getWallpaperData(90)'), wallpaperCrop)
    assert.deepEqual(transportCalls.at(-1), ['wallpaper:data', 90, { original: false }])
    assert.equal(await js('window.api.getWallpaperData(90,true)'), wallpaperOriginal)
    assert.deepEqual(transportCalls.at(-1), ['wallpaper:data', 90, { original: true }])
    assert.equal(await js('window.api.getWallpaperThumbnail(-1)'), null)
    assert.equal(await js('window.api.getWallpaperData(-1)'), null)
    const cropPayload = {
      sourceId: 10,
      cropped: { base64: 'controlled-pixels', ext: 'png' },
      crop: { x: 0, y: 0, width: 2, height: 2 }
    }
    assert.deepEqual(await js(`window.api.saveWallpaper(${JSON.stringify(cropPayload)})`), {
      id: 91,
      title: 'controlled saved wallpaper'
    })
    assert.deepEqual(transportCalls.at(-1), ['wallpaper:save', cropPayload])
    await assert.rejects(js('window.api.saveWallpaper(null)'), /Controlled wallpaper crop missing/)
    assert.deepEqual(transportCalls.at(-1), ['wallpaper:save', {}])
    assert.equal(wallpaperLibrary.length, 2)
    await assert.rejects(js('window.api.activateWallpaper(-1)'), /Controlled wallpaper not found/)
    assert.deepEqual(wallpaperSettings, { enabled: false, activeId: null })
    assert.deepEqual(await js('window.api.activateWallpaper(91)'), {
      record: { id: 91, title: 'controlled saved wallpaper' },
      snapshot: { wallpaper: { enabled: true, activeId: 91 } }
    })
    assert.deepEqual(transportCalls.at(-1), ['wallpaper:activate', { id: 91 }])
    assert.deepEqual(await js('window.api.disableWallpaper()'), {
      wallpaper: { enabled: false, activeId: 91 }
    })
    assert.deepEqual(transportCalls.at(-1), ['wallpaper:disable'])
    assert.equal(await js('window.api.deleteWallpaper(91)'), true)
    assert.deepEqual(transportCalls.at(-1), ['wallpaper:delete', { id: 91 }])
    assert.deepEqual(await js('window.api.listWallpapers()'), [
      { id: 90, title: 'controlled existing wallpaper' }
    ])
    assert.equal(await js('window.api.deleteWallpaper(91)'), false)

    const oldIdentity = host.readIdentity()
    window.destroy()
    assert.equal(host.getWindow(), null)
    const replacement = host.create(options)
    host.installClosedCleanup(replacement, () => {})
    await host.load(replacement, page)
    assert.equal(host.readIdentity().generation, oldIdentity.generation + 1)
    assert.equal(
      (await replacement.webContents.executeJavaScript('window.api.getAppInfo()')).version,
      app.getVersion()
    )
    await assert.rejects(other('window.api.getAppInfo()'), /无权访问/)
    const replacementJs = (code) => replacement.webContents.executeJavaScript(code)
    assert.deepEqual(
      (await replacementJs('window.api.listPendingRemoteNotices()')).map(({ id }) => id),
      [2]
    )
    assert.deepEqual(await replacementJs('window.api.listWallpapers()'), [
      { id: 90, title: 'controlled existing wallpaper' }
    ])
    const callsBeforeReplacementOutsider = structuredClone(transportCalls)
    for (const code of transportInvocations) await assert.rejects(other(code), /无权访问/)
    assert.deepEqual(transportCalls, callsBeforeReplacementOutsider)
    disposeRemoteNotices()
    disposeRemoteNotices()
    disposeWallpapers()
    disposeWallpapers()
    for (const code of transportInvocations)
      await assert.rejects(replacementJs(code), /No handler registered/)
    dispose()
    dispose()
    await assert.rejects(
      replacement.webContents.executeJavaScript('window.api.getAppInfo()'),
      /No handler registered/
    )
    completed = true
  } catch (error) {
    failure = error
    console.error(error)
  } finally {
    dispose()
    disposeRemoteNotices()
    disposeWallpapers()
    clearDb()
    remoteDatabase?.close()
    remoteDatabase = null
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    app.quit()
  }
}
app.once('will-quit', () => {
  const cleanup = { status: 'complete' }
  if (profile.ownership === 'script') {
    try {
      rmSync(profile.directory, { recursive: true, force: true })
    } catch (error) {
      cleanup.status = 'failed'
      cleanup.error = error.message
    }
  }
  recorder.finish({
    completed,
    error: failure,
    cleanup,
    evidence: { status: 'complete' },
    profileOwnership: profile.ownership
  })
  app.exit(completed && cleanup.status === 'complete' ? 0 : 1)
})
app.whenReady().then(run)
