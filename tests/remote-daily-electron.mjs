import { createServer } from 'node:http'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import Database from 'better-sqlite3'
import { setDb, clearDb } from '../src/main/db/db-connection.js'
import { createRemoteServiceSchema } from '../src/main/db/db-schema.js'
import { getRemoteDailyState, saveRemoteDailyState } from '../src/main/db/db-remote-daily.js'
import {
  queueRemoteSessionEnd,
  listPendingRemoteSessionEnds,
  markRemoteSessionEndAttempt,
  removePendingRemoteSessionEnd
} from '../src/main/db/db-remote-sessions.js'
import { RemoteCoordinator } from '../src/main/services/remote/remote-coordinator.js'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/remote-daily-electron.mjs',
  mode: 'electron-ready-remote-daily-http-sqlite',
  prefix: 'abandon-remote-daily-',
  metadata: { realHttp: true, diskDatabase: true, simulatedClock: true, realAppBootstrap: false }
})
const { assert } = lifecycle
const directory = lifecycle.root
app.setPath('userData', directory)
const events = []
const epoch = '123e4567-e89b-42d3-a456-426614174000'
const server = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  events.push({ path: request.url, body })
  response.setHeader('content-type', 'application/json')
  response.end(
    JSON.stringify(
      request.url === '/health'
        ? {
            status: 'ok',
            api_version: 2,
            service_state: 'active',
            report_service: true,
            stats_protocol: 3,
            stats_epoch: epoch
          }
        : request.url === '/session/start'
          ? { session_id: body.session_id }
          : { ok: true }
    )
  )
})
let db
let coordinator
let failure = null
async function run() {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const dbPath = join(directory, 'remote.db')
    db = new Database(dbPath)
    setDb(db)
    createRemoteServiceSchema(db)
    let now = Date.now()
    const settings = { remote: { receiveNotices: false, uploadDeviceInfo: true } }
    coordinator = new RemoteCoordinator({
      app,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      getSettings: () => settings,
      getInstallationId: () => epoch,
      getDailyState: getRemoteDailyState,
      saveDailyState: saveRemoteDailyState,
      queueSessionEnd: queueRemoteSessionEnd,
      listPendingSessionEnds: listPendingRemoteSessionEnds,
      markSessionEndAttempt: markRemoteSessionEndAttempt,
      removePendingSessionEnd: removePendingRemoteSessionEnd,
      now: () => now,
      random: () => 0
    })
    await coordinator.start()
    assert.equal(events.filter((event) => event.path === '/session/start').length, 1)
    await coordinator.runDaily()
    assert.equal(events.filter((event) => event.path === '/activity/daily').length, 0)
    now += 86400000
    await coordinator.runDaily()
    assert.equal(events.filter((event) => event.path === '/activity/daily').length, 1)
    await coordinator.runDaily()
    assert.equal(events.filter((event) => event.path === '/activity/daily').length, 1)
    const before = events.length
    settings.remote.uploadDeviceInfo = false
    coordinator.settingsChanged()
    now += 86400000
    await coordinator.runDaily()
    assert.equal(events.length, before)
    settings.remote.uploadDeviceInfo = true
    await coordinator.stop()
    assert.equal(events.filter((event) => event.path === '/session/end').length, 1)
    assert.equal(listPendingRemoteSessionEnds().length, 0)
    const persisted = getRemoteDailyState()
    db.close()
    db = new Database(dbPath)
    setDb(db)
    assert.deepEqual(getRemoteDailyState(), persisted)
    console.log(
      'REMOTE_DAILY_ELECTRON_OK: actual Electron GPU/device start, HTTP, daily deduplication, permission, shutdown and SQLite reopen'
    )
  } catch (error) {
    failure = error
    console.error(error)
  } finally {
    await lifecycle.finish({
      completed: !failure,
      error: failure,
      summary: { events },
      restore: async () => {
        await coordinator?.stop()
        clearDb()
        if (db?.open) db.close()
        await new Promise((resolve) => server.close(resolve))
      }
    })
  }
}
app.whenReady().then(run)
