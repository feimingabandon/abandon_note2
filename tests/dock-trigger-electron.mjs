import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { app, BrowserWindow, screen } from 'electron'
import koffi from 'koffi'

const POLL_INTERVAL_MS = 100
const EVENT_TIMEOUT_MS = 3000

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function waitUntil(predicate, message, timeoutMs = EVENT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(20)
  }
  throw new Error(message)
}

app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})

async function runNativeEdgeMonitorTests() {
  const dll = koffi.load(resolve('native_blur', 'build', 'bin', 'blur_engine.dll'))
  const arm = dll.func('WindowMotion_ArmEdgeMonitor', 'int', [
    'intptr_t',
    'int',
    'int',
    'int',
    'uint64_t'
  ])
  const disarm = dll.func('WindowMotion_DisarmEdgeMonitor', 'int', ['uint64_t'])
  const getMessageId = dll.func('WindowMotion_GetEdgeMessageId', 'uint', [])
  const getStatusJson = dll.func('WindowMotion_GetEdgeMonitorStatusJson', 'str', [])
  const consumeEventJson = dll.func('WindowMotion_ConsumeEdgeEventJson', 'str', [])
  const user32 = koffi.load('user32.dll')
  const setCursorPos = user32.func('int SetCursorPos(int X, int Y)')
  const getForegroundWindow = user32.func('intptr_t GetForegroundWindow()')

  async function moveCursorAndConfirm(point) {
    assert.equal(setCursorPos(point.x, point.y), 1)
    await waitUntil(() => {
      const current = screen.getCursorScreenPoint()
      if (current.x === point.x && current.y === point.y) return true
      setCursorPos(point.x, point.y)
      return false
    }, `无法将鼠标移动到 (${point.x}, ${point.y})`)
  }

  async function moveCursorAndWaitForEvent(point, eventPromise, timeoutMessage) {
    assert.equal(setCursorPos(point.x, point.y), 1)
    // Windows 偶尔会在显示器/窗口切换时覆盖一次测试注入的鼠标位置；在同一个
    // 有界等待窗口内重申目标位置，避免把系统输入竞争误判成原生监视器回归。
    const retryTimer = setInterval(() => setCursorPos(point.x, point.y), POLL_INTERVAL_MS * 2)
    try {
      return await Promise.race([
        eventPromise,
        wait(EVENT_TIMEOUT_MS).then(() => {
          throw new Error(timeoutMessage)
        })
      ])
    } finally {
      clearInterval(retryTimer)
    }
  }

  function getHandle(window) {
    const buffer = window.getNativeWindowHandle()
    return buffer.length >= 8 ? Number(buffer.readBigUInt64LE()) : buffer.readUInt32LE()
  }

  function getStatus() {
    return JSON.parse(getStatusJson())
  }

  async function startForegroundHelper(mode, bounds) {
    const childEnvironment = { ...process.env }
    delete childEnvironment.ELECTRON_RUN_AS_NODE
    const child = spawn(
      process.execPath,
      [resolve('tests', 'fullscreen-foreground-electron.mjs'), mode, JSON.stringify(bounds)],
      {
        env: childEnvironment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    let output = ''
    let errorOutput = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      errorOutput += chunk
    })
    try {
      await waitUntil(
        () => output.includes(`FOREGROUND_READY:${mode}`),
        `${mode} 前台测试窗口未就绪：${errorOutput}`
      )
    } catch (error) {
      child.kill()
      throw error
    }
    return { child, output: () => output, errorOutput: () => errorOutput }
  }

  async function stopForegroundHelper(helper) {
    const child = helper?.child
    if (!child || child.exitCode !== null) return
    const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise))
    child.stdin.write('quit\n')
    await Promise.race([exited, wait(2000)])
    if (child.exitCode === null) child.kill()
  }

  function getBounds(side, workArea) {
    const width = 480
    const height = 240
    return {
      x:
        side === -1
          ? workArea.x
          : side === 1
            ? workArea.x + workArea.width - width
            : workArea.x + Math.floor((workArea.width - width) / 2),
      y: side === -2 ? workArea.y : workArea.y + Math.floor((workArea.height - height) / 2),
      width,
      height
    }
  }

  function getOutsidePoint(workArea) {
    return {
      x: workArea.x + Math.floor(workArea.width / 2),
      y: workArea.y + Math.floor(workArea.height / 2)
    }
  }

  function getInsidePoint(side, bounds, workArea) {
    if (side === -1) return { x: workArea.x, y: bounds.y + Math.floor(bounds.height / 2) }
    if (side === 1) {
      return { x: workArea.x + workArea.width - 1, y: bounds.y + Math.floor(bounds.height / 2) }
    }
    return { x: bounds.x + Math.floor(bounds.width / 2), y: workArea.y }
  }

  let testWindow = null
  let originalCursor = null
  let generation = 0
  let foregroundHelper = null

  try {
    originalCursor = screen.getCursorScreenPoint()
    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workArea
    const messageId = getMessageId()
    assert.ok(messageId > 0, 'DLL 必须注册有效的 Windows 边缘消息')

    for (const side of [-1, 1, -2]) {
      const bounds = getBounds(side, workArea)
      testWindow = new BrowserWindow({
        ...bounds,
        show: true,
        frame: false,
        transparent: false,
        thickFrame: false
      })
      const outside = getOutsidePoint(workArea)
      assert.equal(setCursorPos(outside.x, outside.y), 1)
      await wait(150)

      generation += 1
      let resolveEvent
      const eventPromise = new Promise((resolvePromise) => {
        resolveEvent = resolvePromise
      })
      testWindow.hookWindowMessage(messageId, () => {
        const event = JSON.parse(consumeEventJson())
        if (event.kind !== 'none') resolveEvent(event)
      })

      assert.equal(
        arm(getHandle(testWindow), side, 2, POLL_INTERVAL_MS, generation),
        1,
        `${side} 原生边缘监视器必须启动成功`
      )
      const armedStatus = await waitUntil(() => {
        const status = getStatus()
        return status.workerAlive && ['armed', 'waiting-outside'].includes(status.state) && status
      }, `${side} 原生边缘监视线程没有进入可用状态`)
      assert.equal(armedStatus.generation, generation)
      assert.equal(armedStatus.side, side)
      assert.equal(armedStatus.pollIntervalMs, POLL_INTERVAL_MS)
      if (side === -1) {
        assert.equal(disarm(generation + 100), 1, '旧会话停止请求应当安全忽略')
        assert.equal(getStatus().workerAlive, true, '错误 generation 不得停止当前监视器')
      }

      const inside = getInsidePoint(side, bounds, workArea)
      const event = await moveCursorAndWaitForEvent(
        inside,
        eventPromise,
        `${side} 原生边缘监视器没有在真实鼠标触边后发送消息`
      )
      assert.deepEqual(
        { kind: event.kind, generation: event.generation, side: event.side },
        { kind: 'trigger', generation, side }
      )
      assert.equal(disarm(generation), 1)
      await waitUntil(() => getStatus().state === 'stopped', `${side} 原生边缘监视器没有停止`)
      testWindow.destroy()
      testWindow = null
    }

    // 启动时鼠标已经在触发区，必须先离开再进入，避免窗口隐藏后立即反弹。
    const topBounds = getBounds(-2, workArea)
    testWindow = new BrowserWindow({
      ...topBounds,
      show: true,
      frame: false,
      thickFrame: false
    })
    const topInside = getInsidePoint(-2, topBounds, workArea)
    assert.equal(setCursorPos(topInside.x, topInside.y), 1)
    await wait(100)
    generation += 1
    assert.equal(arm(getHandle(testWindow), -2, 2, POLL_INTERVAL_MS, generation), 1)
    await waitUntil(() => getStatus().state === 'waiting-outside', '鼠标初始位于顶部时必须等待离开')
    await wait(250)
    assert.equal(getStatus().pendingEvent, 'none', '鼠标未离开前不得立即触发')
    const outside = getOutsidePoint(workArea)
    assert.equal(setCursorPos(outside.x, outside.y), 1)
    await waitUntil(() => getStatus().state === 'armed', '鼠标离开后没有重新布防')

    let resolveTopEvent
    const topEventPromise = new Promise((resolvePromise) => {
      resolveTopEvent = resolvePromise
    })
    testWindow.hookWindowMessage(messageId, () => {
      const event = JSON.parse(consumeEventJson())
      if (event.kind !== 'none') resolveTopEvent(event)
    })
    const topEvent = await moveCursorAndWaitForEvent(
      topInside,
      topEventPromise,
      '鼠标离开并重新触顶后没有触发'
    )
    assert.equal(topEvent.kind, 'trigger')
    assert.equal(disarm(generation), 1)

    // 同一显示器由其他进程真正全屏覆盖时，触边必须保持隐藏。退出全屏后也不能
    // 因鼠标仍停在边缘而突然弹出，必须离开并重新进入才允许触发。
    await moveCursorAndConfirm(outside)
    foregroundHelper = await startForegroundHelper('fullscreen', primaryDisplay.bounds)
    assert.notEqual(Number(getForegroundWindow()), 0, '全屏辅助窗口未成为有效前台窗口')
    generation += 1
    assert.equal(arm(getHandle(testWindow), -2, 2, POLL_INTERVAL_MS, generation), 1)
    await waitUntil(() => getStatus().workerAlive, '全屏测试的边缘监视线程未启动')
    await moveCursorAndConfirm(topInside)
    const blockedStatus = await waitUntil(
      () => {
        const status = getStatus()
        return status.fullscreenBlockCount === 1 && status.state === 'waiting-outside' && status
      },
      `其他进程全屏时触边没有被抑制；helper=${foregroundHelper.output()}；status=${JSON.stringify(getStatus())}`
    )
    assert.equal(blockedStatus.pendingEvent, 'none', '全屏拦截不得向主进程发布唤出事件')

    await stopForegroundHelper(foregroundHelper)
    foregroundHelper = null
    await wait(250)
    assert.equal(getStatus().state, 'waiting-outside', '退出全屏时鼠标未离边不得自动触发')
    assert.equal(getStatus().pendingEvent, 'none', '退出全屏时不得补发旧触边意图')
    assert.equal(setCursorPos(outside.x, outside.y), 1)
    await waitUntil(() => getStatus().state === 'armed', '全屏拦截后离开边缘没有重新布防')
    testWindow.focus()

    testWindow.unhookWindowMessage(messageId)
    let resolveAfterFullscreenEvent
    const afterFullscreenEventPromise = new Promise((resolvePromise) => {
      resolveAfterFullscreenEvent = resolvePromise
    })
    testWindow.hookWindowMessage(messageId, () => {
      const event = JSON.parse(consumeEventJson())
      if (event.kind !== 'none') resolveAfterFullscreenEvent(event)
    })
    const afterFullscreenEvent = await moveCursorAndWaitForEvent(
      topInside,
      afterFullscreenEventPromise,
      '离开全屏并重新触边后没有恢复正常唤出'
    )
    assert.equal(afterFullscreenEvent.kind, 'trigger')
    assert.equal(disarm(generation), 1)

    // 普通最大化窗口不属于全屏游戏保护范围，仍应正常触发。
    await moveCursorAndConfirm(outside)
    foregroundHelper = await startForegroundHelper('maximized', primaryDisplay.bounds)
    generation += 1
    testWindow.unhookWindowMessage(messageId)
    let resolveMaximizedEvent
    const maximizedEventPromise = new Promise((resolvePromise) => {
      resolveMaximizedEvent = resolvePromise
    })
    testWindow.hookWindowMessage(messageId, () => {
      const event = JSON.parse(consumeEventJson())
      if (event.kind !== 'none') resolveMaximizedEvent(event)
    })
    assert.equal(arm(getHandle(testWindow), -2, 2, POLL_INTERVAL_MS, generation), 1)
    await waitUntil(() => getStatus().workerAlive, '最大化测试的边缘监视线程未启动')
    const maximizedEvent = await moveCursorAndWaitForEvent(
      topInside,
      maximizedEventPromise,
      '普通最大化窗口错误地阻止了贴边唤出'
    )
    assert.equal(maximizedEvent.kind, 'trigger')
    assert.equal(getStatus().fullscreenBlockCount, 0)
    assert.equal(disarm(generation), 1)
    await stopForegroundHelper(foregroundHelper)
    foregroundHelper = null

    assert.equal(setCursorPos(outside.x, outside.y), 1)
    for (let cycle = 0; cycle < 100; cycle += 1) {
      generation += 1
      assert.equal(
        arm(getHandle(testWindow), -2, 2, POLL_INTERVAL_MS, generation),
        1,
        `第 ${cycle + 1} 轮原生监视器没有启动`
      )
      assert.equal(disarm(generation), 1, `第 ${cycle + 1} 轮原生监视器没有停止`)
    }
    assert.equal(getStatus().state, 'stopped', '压力循环后原生监视器必须完全停止')

    console.log(
      'native edge monitor integration test passed: left/right/top polling, Windows message delivery, fullscreen suppression, maximized-window passthrough, generation isolation, initial-inside rearm and 100 lifecycle cycles'
    )
  } finally {
    disarm(0)
    await stopForegroundHelper(foregroundHelper)
    if (testWindow && !testWindow.isDestroyed()) testWindow.destroy()
    if (originalCursor) setCursorPos(originalCursor.x, originalCursor.y)
  }
  app.exit(0)
}

app
  .whenReady()
  .then(runNativeEdgeMonitorTests)
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
