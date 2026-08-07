import assert from 'node:assert/strict'
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

  function getHandle(window) {
    const buffer = window.getNativeWindowHandle()
    return buffer.length >= 8 ? Number(buffer.readBigUInt64LE()) : buffer.readUInt32LE()
  }

  function getStatus() {
    return JSON.parse(getStatusJson())
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

  try {
    originalCursor = screen.getCursorScreenPoint()
    const workArea = screen.getPrimaryDisplay().workArea
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
      assert.equal(setCursorPos(inside.x, inside.y), 1)
      const event = await Promise.race([
        eventPromise,
        wait(EVENT_TIMEOUT_MS).then(() => {
          throw new Error(`${side} 原生边缘监视器没有在真实鼠标触边后发送消息`)
        })
      ])
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
    assert.equal(setCursorPos(topInside.x, topInside.y), 1)
    const topEvent = await Promise.race([
      topEventPromise,
      wait(EVENT_TIMEOUT_MS).then(() => {
        throw new Error('鼠标离开并重新触顶后没有触发')
      })
    ])
    assert.equal(topEvent.kind, 'trigger')
    assert.equal(disarm(generation), 1)

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
      'native edge monitor integration test passed: left/right/top polling, Windows message delivery, generation isolation, initial-inside rearm and 100 lifecycle cycles'
    )
  } finally {
    disarm(0)
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
