import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { app, BrowserWindow, screen } from 'electron'
import koffi from 'koffi'

const POLL_INTERVAL_MS = 50
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
  const dll = koffi.load(
    process.env.ABANDON_INTEGRATION_NATIVE_DLL ||
      resolve('native_blur', 'build', 'bin', 'blur_engine.dll')
  )
  const arm = dll.func('WindowMotion_ArmEdgeMonitor', 'int', [
    'intptr_t',
    'int',
    'int',
    'int',
    'uint64_t'
  ])
  const armEx = dll.func('WindowMotion_ArmEdgeMonitorEx', 'int', [
    'intptr_t',
    'int',
    'int',
    'int',
    'uint64_t',
    'int'
  ])
  const disarm = dll.func('WindowMotion_DisarmEdgeMonitor', 'int', ['uint64_t'])
  const getMessageId = dll.func('WindowMotion_GetEdgeMessageId', 'uint', [])
  const getStatusJson = dll.func('WindowMotion_GetEdgeMonitorStatusJson', 'str', [])
  const consumeEventJson = dll.func('WindowMotion_ConsumeEdgeEventJson', 'str', [])
  const user32 = koffi.load('user32.dll')
  const setCursorPos = user32.func('int SetCursorPos(int X, int Y)')
  const getForegroundWindow = user32.func('intptr_t GetForegroundWindow()')
  const mouseEvent = user32.func(
    'void mouse_event(uint flags, uint dx, uint dy, uint data, uintptr_t extraInfo)'
  )

  async function moveCursorAndConfirm(point) {
    assert.equal(setCursorPos(point.x, point.y), 1)
    await waitUntil(() => {
      const current = screen.getCursorScreenPoint()
      if (current.x === point.x && current.y === point.y) return true
      setCursorPos(point.x, point.y)
      return false
    }, `无法将鼠标移动到 (${point.x}, ${point.y})`)
  }

  async function moveCursorAndWaitForStatus(point, predicate, message) {
    const retryTimer = setInterval(() => setCursorPos(point.x, point.y), POLL_INTERVAL_MS * 2)
    try {
      await moveCursorAndConfirm(point)
      return await waitUntil(() => predicate(getStatus()), message)
    } finally {
      clearInterval(retryTimer)
    }
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
          throw new Error(`${timeoutMessage}；状态=${JSON.stringify(getStatus())}`)
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

  function assertHandleSize(status, side) {
    const dpi = Math.max(96, Number(status.handleDpi) || 96)
    const expectedHorizontalWidth = Math.round((146 * dpi) / 96)
    const expectedHorizontalHeight = Math.round((40 * dpi) / 96)
    const expectedVerticalWidth = Math.round((50 * dpi) / 96)
    const expectedVerticalHeight = Math.round((112 * dpi) / 96)
    const width = status.handleRect.right - status.handleRect.left
    const height = status.handleRect.bottom - status.handleRect.top
    const expectedWidth =
      side === -1 || side === 1 ? expectedVerticalWidth : expectedHorizontalWidth
    const expectedHeight =
      side === -1 || side === 1 ? expectedVerticalHeight : expectedHorizontalHeight
    assert.ok(
      Math.abs(width - expectedWidth) <= 1 && Math.abs(height - expectedHeight) <= 1,
      `${side} 小黑条尺寸应为 ${expectedWidth}×${expectedHeight}px，实际为 ${width}×${height}px`
    )
  }

  function movedTowardOutside(side, current, ready) {
    if (side === -1) return current.left < ready.left
    if (side === 1) return current.left > ready.left
    if (side === -2) return current.top < ready.top
    return current.top > ready.top
  }

  function isPartiallyVisible(status, side, workArea) {
    if (status.handleState !== 'appearing' || !status.handleWindowAlive) return false
    const boundary = {
      left: workArea.x,
      right: workArea.x + workArea.width,
      top: workArea.y
    }
    if (side === -1) {
      return status.handleRect.left < boundary.left && status.handleRect.right > boundary.left
    }
    if (side === 1) {
      return status.handleRect.left < boundary.right && status.handleRect.right > boundary.right
    }
    return status.handleRect.top < boundary.top && status.handleRect.bottom > boundary.top
  }

  async function revealHandleAndAssertSliding(point, side, workArea, message) {
    const retryTimer = setInterval(() => setCursorPos(point.x, point.y), POLL_INTERVAL_MS * 2)
    let sawIntermediatePosition = false
    try {
      await moveCursorAndConfirm(point)
      const ready = await waitUntil(() => {
        const status = getStatus()
        if (isPartiallyVisible(status, side, workArea)) sawIntermediatePosition = true
        return status.handleState === 'ready' && status.handleWindowAlive && status
      }, message)
      assert.equal(
        sawIntermediatePosition,
        true,
        `${side} 小黑条首次冷启动必须从屏外滑入，不得直接跳到终点`
      )
      return ready
    } finally {
      clearInterval(retryTimer)
    }
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

  function getAlternateInsidePoint(side, bounds, workArea) {
    if (side === -1) return { x: workArea.x, y: bounds.y + Math.floor((bounds.height * 3) / 4) }
    if (side === 1) {
      return {
        x: workArea.x + workArea.width - 1,
        y: bounds.y + Math.floor((bounds.height * 3) / 4)
      }
    }
    return { x: bounds.x + Math.floor((bounds.width * 3) / 4), y: workArea.y }
  }

  function getNearHandlePoint(status, side) {
    const dpi = Math.max(96, Number(status.handleDpi) || 96)
    const offset = Math.max(1, Math.round((6 * dpi) / 96))
    const rect = status.handleRect
    if (side === -1 || side === 1) {
      return {
        x: Math.floor((rect.left + rect.right) / 2),
        y: rect.bottom + offset
      }
    }
    return {
      x: rect.right + offset,
      y: Math.floor((rect.top + rect.bottom) / 2)
    }
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
      const armedStatus = getStatus()
      assert.equal(armedStatus.workerAlive, true, `${side} Arm 返回前监视线程必须已经就绪`)
      assert.ok(
        ['armed', 'waiting-outside'].includes(armedStatus.state),
        `${side} Arm 返回后监视器状态必须可用`
      )
      assert.equal(armedStatus.handleRenderer, 'disabled', 'direct 模式不得初始化小黑条渲染器')
      assert.equal(armedStatus.generation, generation)
      assert.equal(armedStatus.side, side)
      assert.equal(armedStatus.pollIntervalMs, POLL_INTERVAL_MS)
      await moveCursorAndConfirm(outside)
      await waitUntil(() => getStatus().state === 'armed', `${side} 直触场景没有在离边位置稳定布防`)
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

    // 点击小黑条模式：首次触边只揭示原生小黑条；动画完成后一次新的完整点击才发 trigger。
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
      await moveCursorAndConfirm(outside)
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
        armEx(getHandle(testWindow), side, 2, POLL_INTERVAL_MS, generation, 1),
        1,
        `${side} 点击小黑条模式必须启动成功`
      )
      const armedHandleStatus = getStatus()
      assert.equal(
        armedHandleStatus.workerAlive,
        true,
        `${side} 小黑条 ArmEx 返回前监视线程必须已经就绪`
      )
      assert.equal(armedHandleStatus.mode, 'click-handle')
      assert.equal(armedHandleStatus.handleState, 'hidden')
      assert.equal(armedHandleStatus.handleWindowAlive, true)
      assert.equal(armedHandleStatus.handleVisible, false)
      assert.equal(armedHandleStatus.handleWindowCreateCount, 1)
      assert.equal(armedHandleStatus.handleRenderer, 'direct2d')
      assert.equal(armedHandleStatus.handlePrewarmed, true)
      await moveCursorAndConfirm(outside)
      await waitUntil(
        () => getStatus().state === 'armed',
        `${side} 点击小黑条场景没有在离边位置稳定布防`
      )
      const readyHandle = await revealHandleAndAssertSliding(
        getInsidePoint(side, bounds, workArea),
        side,
        workArea,
        `${side} 首次触边后没有完成小黑条滑入动画`
      )
      assert.equal(readyHandle.pendingEvent, 'none', '小黑条揭示本身不得唤出主窗口')
      assert.ok(readyHandle.handleRect.right > readyHandle.handleRect.left)
      assert.ok(readyHandle.handleRect.bottom > readyHandle.handleRect.top)
      assertHandleSize(readyHandle, side)
      assert.equal(readyHandle.handleRenderer, 'direct2d', '小黑条应使用 Direct2D 绘制猫猫头像')
      assert.equal(readyHandle.handleEmbeddedFont, true, '小黑条应使用嵌入的 OPPO Sans 字体')
      const firstVisualFrame = readyHandle.handleVisualFrame
      await waitUntil(
        () => getStatus().handleVisualFrame > firstVisualFrame,
        `${side} 猫猫头像外圈在 ready 状态下没有持续刷新`
      )

      // 小黑条只按首次触边点定位。鼠标继续沿边移动时它必须保持稳定，
      // 不能追逐鼠标成为难以点击的移动目标。
      await moveCursorAndConfirm(getAlternateInsidePoint(side, bounds, workArea))
      await wait(POLL_INTERVAL_MS * 3)
      const fixedHandle = getStatus()
      assert.equal(fixedHandle.handleState, 'ready')
      assert.deepEqual(
        fixedHandle.handleRect,
        readyHandle.handleRect,
        `${side} 小黑条出现后不得继续沿边跟随鼠标`
      )

      // 实际 HWND 外的 6 DIP 不拦截点击，但仍位于 8 DIP 离开迟滞区内；
      // 即使停留超过 300ms，也不能因轻微晃动开始退场。
      await moveCursorAndConfirm(getNearHandlePoint(readyHandle, side))
      await wait(450)
      const tolerantHandle = getStatus()
      assert.equal(tolerantHandle.handleState, 'ready', `${side} 小黑条的 8 DIP 离开迟滞未生效`)
      assert.deepEqual(tolerantHandle.handleRect, readyHandle.handleRect)

      // 离开边线和小黑条后必须沿出现路径反向退场；退场途中重新触边则反向出现。
      const retreatingHandle = await moveCursorAndWaitForStatus(
        outside,
        (status) =>
          status.handleState === 'retreating' &&
          movedTowardOutside(side, status.handleRect, readyHandle.handleRect) &&
          status,
        `${side} 小黑条离开后没有沿屏外方向退场`
      )
      assert.equal(retreatingHandle.pendingEvent, 'none', '小黑条退场不得产生唤出事件')
      const reversingHandle = await moveCursorAndWaitForStatus(
        getInsidePoint(side, bounds, workArea),
        (status) =>
          ['appearing', 'ready'].includes(status.handleState) &&
          status.handleWindowAlive &&
          status.pendingEvent === 'none' &&
          status,
        `${side} 小黑条退场中重新触边后被销毁或没有反向恢复`
      )
      assertHandleSize(reversingHandle, side)
      const restoredHandle = await waitUntil(() => {
        const status = getStatus()
        return status.handleState === 'ready' && status.handleWindowAlive && status
      }, `${side} 小黑条反向出现后没有恢复就绪`)
      assertHandleSize(restoredHandle, side)

      // 移动真实系统光标并注入一轮新的完整按下/释放，覆盖命中区域与无激活输入路径。
      await moveCursorAndConfirm({
        x: Math.floor((restoredHandle.handleRect.left + restoredHandle.handleRect.right) / 2),
        y: Math.floor((restoredHandle.handleRect.top + restoredHandle.handleRect.bottom) / 2)
      })
      mouseEvent(0x0002, 0, 0, 0, 0) // MOUSEEVENTF_LEFTDOWN
      mouseEvent(0x0004, 0, 0, 0, 0) // MOUSEEVENTF_LEFTUP
      const event = await Promise.race([
        eventPromise,
        wait(EVENT_TIMEOUT_MS).then(() => {
          throw new Error(`${side} 完整点击小黑条后没有收到 trigger`)
        })
      ])
      assert.deepEqual(
        { kind: event.kind, generation: event.generation, side: event.side },
        { kind: 'trigger', generation, side }
      )
      assert.equal(disarm(generation), 1)
      testWindow.destroy()
      testWindow = null
    }

    // 完整退场后 HWND 保留在屏外复用；下一次出现不得重新创建冷启动窗口。
    const retreatBounds = getBounds(-2, workArea)
    testWindow = new BrowserWindow({
      ...retreatBounds,
      show: true,
      frame: false,
      thickFrame: false
    })
    const retreatInside = getInsidePoint(-2, retreatBounds, workArea)
    const retreatOutside = getOutsidePoint(workArea)
    await moveCursorAndConfirm(retreatOutside)
    generation += 1
    assert.equal(
      armEx(getHandle(testWindow), -2, 2, POLL_INTERVAL_MS, generation, 1),
      1,
      '小黑条完整退场场景必须启动成功'
    )
    await waitUntil(() => getStatus().workerAlive, '小黑条完整退场场景的监视线程没有启动')
    await moveCursorAndConfirm(retreatOutside)
    await waitUntil(() => getStatus().state === 'armed', '小黑条完整退场场景没有完成离边布防')
    const retreatReady = await moveCursorAndWaitForStatus(
      retreatInside,
      (status) => status.handleState === 'ready' && status.handleWindowAlive && status,
      '小黑条完整退场场景没有进入 ready'
    )
    assert.ok(retreatReady.handleVisualElapsedMs > 0, '首次显示时绿环必须累计可见时间')
    await moveCursorAndWaitForStatus(
      retreatOutside,
      (status) =>
        status.handleState === 'retreating' &&
        movedTowardOutside(-2, status.handleRect, retreatReady.handleRect),
      '小黑条没有播放滑回屏外动画'
    )
    const retreated = await waitUntil(() => {
      const status = getStatus()
      return (
        status.handleState === 'hidden' &&
        status.handleWindowAlive &&
        !status.handleVisible &&
        status
      )
    }, '小黑条退场完成后没有停留在屏外复用')
    assert.equal(retreated.pendingEvent, 'none', '小黑条完整退场不得产生原生事件')
    assert.equal(retreated.handleWindowCreateCount, 1, '完整退场不得销毁预热窗口')
    const pausedVisualElapsedMs = retreated.handleVisualElapsedMs
    const pausedVisualFrame = retreated.handleVisualFrame
    await wait(250)
    const stillPaused = getStatus()
    assert.equal(
      stillPaused.handleVisualElapsedMs,
      pausedVisualElapsedMs,
      '屏外隐藏时绿环时间必须暂停'
    )
    assert.equal(stillPaused.handleVisualFrame, pausedVisualFrame, '屏外隐藏时不得继续重绘绿环')
    const reusedReady = await revealHandleAndAssertSliding(
      retreatInside,
      -2,
      workArea,
      '复用的小黑条没有再次完成滑入动画'
    )
    assert.equal(reusedReady.handleWindowCreateCount, 1, '重复出现不得重新创建小黑条 HWND')
    assert.ok(
      reusedReady.handleVisualElapsedMs > pausedVisualElapsedMs,
      '重复出现后绿环必须从暂停进度继续，不能回到圆圈顶部'
    )
    assert.equal(disarm(generation), 1)
    testWindow.destroy()
    testWindow = null

    // 全屏开始时已显示的小黑条必须立即停回屏外，但 HWND、渲染进度与
    // 监视会话继续存活；退出全屏后必须离开边缘再重新进入。
    const fullscreenHandleBounds = getBounds(-2, workArea)
    testWindow = new BrowserWindow({
      ...fullscreenHandleBounds,
      show: true,
      frame: false,
      thickFrame: false
    })
    const fullscreenHandleInside = getInsidePoint(-2, fullscreenHandleBounds, workArea)
    const outsideAfterHandle = getOutsidePoint(workArea)
    await moveCursorAndConfirm(outsideAfterHandle)
    generation += 1
    assert.equal(
      armEx(getHandle(testWindow), -2, 2, POLL_INTERVAL_MS, generation, 1),
      1,
      '全屏小黑条场景必须启动成功'
    )
    await waitUntil(() => getStatus().workerAlive, '全屏小黑条场景的监视线程没有启动')
    await moveCursorAndConfirm(outsideAfterHandle)
    await waitUntil(() => getStatus().state === 'armed', '全屏小黑条场景没有在离边状态完成布防')
    await moveCursorAndWaitForStatus(
      fullscreenHandleInside,
      (status) => status.handleState === 'ready',
      '进入全屏前小黑条没有就绪'
    )
    foregroundHelper = await startForegroundHelper('fullscreen', primaryDisplay.bounds)
    const handleBlockedStatus = await waitUntil(() => {
      const status = getStatus()
      return (
        status.fullscreenBlockCount === 1 &&
        status.handleState === 'hidden' &&
        status.handleWindowAlive &&
        !status.handleVisible &&
        status
      )
    }, '进入全屏后没有把同一个小黑条停回屏外')
    assert.equal(handleBlockedStatus.workerAlive, true, '全屏不得停止监视线程')
    assert.equal(handleBlockedStatus.handleWindowCreateCount, 1, '全屏不得销毁或重建小黑条 HWND')
    const fullscreenPausedElapsedMs = handleBlockedStatus.handleVisualElapsedMs
    assert.equal(handleBlockedStatus.pendingEvent, 'none')
    await stopForegroundHelper(foregroundHelper)
    foregroundHelper = null
    await wait(250)
    const cursorAfterFullscreen = screen.getCursorScreenPoint()
    const statusAfterFullscreen = getStatus()
    const triggerAfterFullscreen = statusAfterFullscreen.triggerArea
    const cursorStillInside =
      cursorAfterFullscreen.x >= triggerAfterFullscreen.left &&
      cursorAfterFullscreen.x < triggerAfterFullscreen.right &&
      cursorAfterFullscreen.y >= triggerAfterFullscreen.top &&
      cursorAfterFullscreen.y < triggerAfterFullscreen.bottom
    assert.equal(
      statusAfterFullscreen.state,
      cursorStillInside ? 'waiting-outside' : 'armed',
      '退出全屏后必须按当前光标是否仍在触发边线决定等待离边或直接布防'
    )
    assert.equal(statusAfterFullscreen.handleState, 'hidden')
    assert.equal(statusAfterFullscreen.handleWindowAlive, true)
    assert.equal(statusAfterFullscreen.handleWindowCreateCount, 1)
    assert.equal(
      statusAfterFullscreen.handleVisualElapsedMs,
      fullscreenPausedElapsedMs,
      '全屏停放期间绿环时间必须暂停'
    )
    await moveCursorAndConfirm(outsideAfterHandle)
    await waitUntil(() => getStatus().state === 'armed', '退出全屏后离边没有重新布防')
    await moveCursorAndWaitForStatus(
      fullscreenHandleInside,
      (status) => status.handleState === 'ready',
      '退出全屏并重新触边后没有恢复小黑条'
    )
    assert.equal(disarm(generation), 1)
    testWindow.destroy()
    testWindow = null

    // 启动时鼠标已经在触发区，必须先离开再进入，避免窗口隐藏后立即反弹。
    const topBounds = getBounds(-2, workArea)
    testWindow = new BrowserWindow({
      ...topBounds,
      show: true,
      frame: false,
      thickFrame: false
    })
    const topInside = getInsidePoint(-2, topBounds, workArea)
    await moveCursorAndConfirm(topInside)
    generation += 1
    assert.equal(setCursorPos(topInside.x, topInside.y), 1)
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
    await moveCursorAndConfirm(outside)
    await waitUntil(() => getStatus().state === 'armed', '全屏测试没有在离边位置稳定布防')
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
    const directStatusAfterFullscreen = getStatus()
    const directCursorAfterFullscreen = screen.getCursorScreenPoint()
    const directTrigger = directStatusAfterFullscreen.triggerArea
    const directCursorInside =
      directCursorAfterFullscreen.x >= directTrigger.left &&
      directCursorAfterFullscreen.x < directTrigger.right &&
      directCursorAfterFullscreen.y >= directTrigger.top &&
      directCursorAfterFullscreen.y < directTrigger.bottom
    assert.equal(
      directStatusAfterFullscreen.state,
      directCursorInside ? 'waiting-outside' : 'armed',
      '退出全屏后直触监视器必须按当前光标位置决定等待离边或直接布防'
    )
    assert.equal(directStatusAfterFullscreen.pendingEvent, 'none', '退出全屏时不得补发旧触边意图')
    await moveCursorAndConfirm(outside)
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
    await moveCursorAndConfirm(outside)
    await waitUntil(() => getStatus().state === 'armed', '最大化测试没有在离边位置稳定布防')
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
