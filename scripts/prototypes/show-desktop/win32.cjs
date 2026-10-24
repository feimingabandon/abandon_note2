// Isolated Windows desktop experiment. No product code or settings are imported.
const koffi = require('koffi')
const os = require('node:os')

function createWin32() {
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const dwmapi = koffi.load('dwmapi.dll')
  const point = koffi.struct({ x: 'long', y: 'long' })
  const rect = koffi.struct({ left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const enumProc = koffi.proto('int __stdcall PrototypeEnumWindows(uintptr_t hwnd, intptr_t data)')
  const enumWindows = user32.func('EnumWindows', 'int', [koffi.pointer(enumProc), 'intptr_t'])
  const enumChildren = user32.func('EnumChildWindows', 'int', [
    'uintptr_t',
    koffi.pointer(enumProc),
    'intptr_t'
  ])
  const getClassName = user32.func('int GetClassNameW(uintptr_t hwnd, void *buffer, int capacity)')
  const getWindowRect = user32.func('GetWindowRect', 'int', [
    'uintptr_t',
    koffi.out(koffi.pointer(rect))
  ])
  const getCursorPos = user32.func('GetCursorPos', 'int', [koffi.out(koffi.pointer(point))])
  const api = {
    getWindow: user32.func('uintptr_t GetWindow(uintptr_t hwnd, uint command)'),
    getParent: user32.func('uintptr_t GetParent(uintptr_t hwnd)'),
    getAncestor: user32.func('uintptr_t GetAncestor(uintptr_t hwnd, uint flags)'),
    getForeground: user32.func('uintptr_t GetForegroundWindow()'),
    setForeground: user32.func('int SetForegroundWindow(uintptr_t hwnd)'),
    isWindow: user32.func('int IsWindow(uintptr_t hwnd)'),
    isVisible: user32.func('int IsWindowVisible(uintptr_t hwnd)'),
    isIconic: user32.func('int IsIconic(uintptr_t hwnd)'),
    showWindow: user32.func('int ShowWindow(uintptr_t hwnd, int command)'),
    findWindow: user32.func(
      'uintptr_t FindWindowW(const char16_t *className, const char16_t *title)'
    ),
    findChild: user32.func(
      'uintptr_t FindWindowExW(uintptr_t parent, uintptr_t after, const char16_t *className, const char16_t *title)'
    ),
    setParent: user32.func('uintptr_t SetParent(uintptr_t hwnd, uintptr_t parent)'),
    getStyle: user32.func('intptr_t GetWindowLongPtrW(uintptr_t hwnd, int index)'),
    setStyle: user32.func('intptr_t SetWindowLongPtrW(uintptr_t hwnd, int index, intptr_t style)'),
    setPosition: user32.func(
      'int SetWindowPos(uintptr_t hwnd, intptr_t after, int x, int y, int width, int height, uint flags)'
    ),
    screenToClient: user32.func('ScreenToClient', 'int', [
      'uintptr_t',
      koffi.inout(koffi.pointer(point))
    ]),
    windowFromPoint: user32.func('WindowFromPoint', 'uintptr_t', [point]),
    getDC: user32.func('uintptr_t GetDC(uintptr_t hwnd)'),
    releaseDC: user32.func('int ReleaseDC(uintptr_t hwnd, uintptr_t dc)'),
    getPixel: gdi32.func('uint32_t GetPixel(uintptr_t dc, int x, int y)'),
    getLastError: kernel32.func('uint GetLastError()'),
    setLastError: kernel32.func('void SetLastError(uint error)'),
    getPid: user32.func('uint GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint *pid)'),
    setCursor: user32.func('int SetCursorPos(int x, int y)'),
    keyState: user32.func('short GetAsyncKeyState(int key)'),
    getMetrics: user32.func('int GetSystemMetrics(int index)'),
    dwmAttribute: dwmapi.func(
      'int DwmGetWindowAttribute(uintptr_t hwnd, uint attribute, _Out_ uint *value, uint size)'
    )
  }
  const keyboard = koffi.struct({
    wVk: 'uint16_t',
    wScan: 'uint16_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t'
  })
  const mouse = koffi.struct({
    dx: 'long',
    dy: 'long',
    mouseData: 'uint32_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t'
  })
  const input = koffi.struct({ type: 'uint32_t', u: koffi.union({ ki: keyboard, mi: mouse }) })
  const sendInput = user32.func('SendInput', 'uint', ['uint', koffi.pointer(input), 'int'])
  function send(inputs) {
    const sent = sendInput(inputs.length, inputs, koffi.sizeof(input))
    if (sent !== inputs.length)
      throw new Error(`SendInput accepted ${sent}/${inputs.length}: ${api.getLastError()}`)
  }
  api.chord = (keys) =>
    send([
      ...keys.map((wVk) => ({
        type: 1,
        u: { ki: { wVk, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 } }
      })),
      ...[...keys].reverse().map((wVk) => ({
        type: 1,
        u: { ki: { wVk, wScan: 0, dwFlags: 2, time: 0, dwExtraInfo: 0 } }
      }))
    ])
  api.click = (x, y) => {
    if (!api.setCursor(x, y)) throw new Error('SetCursorPos failed')
    send(
      [2, 4].map((dwFlags) => ({
        type: 0,
        u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags, time: 0, dwExtraInfo: 0 } }
      }))
    )
  }
  api.className = (hwnd) => {
    const buffer = Buffer.alloc(512)
    const length = getClassName(hwnd, buffer, 256)
    return buffer.subarray(0, length * 2).toString('utf16le')
  }
  api.rect = (hwnd) => {
    const value = {}
    return getWindowRect(hwnd, value) ? value : null
  }
  api.cursor = () => {
    const value = {}
    if (!getCursorPos(value)) throw new Error('GetCursorPos failed')
    return value
  }
  api.enumerate = (parent = null) => {
    const windows = []
    const callback = (hwnd) => {
      const pid = [0]
      api.getPid(hwnd, pid)
      windows.push({
        hwnd: Number(hwnd),
        parent: Number(api.getParent(hwnd)),
        className: api.className(hwnd),
        visible: !!api.isVisible(hwnd),
        iconic: !!api.isIconic(hwnd),
        pid: pid[0],
        rect: api.rect(hwnd)
      })
      return 1
    }
    if (parent === null) enumWindows(callback, 0)
    else enumChildren(parent, callback, 0)
    return windows
  }
  api.inventory = () => {
    const all = api.enumerate()
    const shell = all.filter((w) =>
      ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'].includes(w.className)
    )
    return {
      os: { version: os.version(), release: os.release(), arch: process.arch },
      foreground: Number(api.getForeground()),
      shells: shell.map((w) => ({
        ...w,
        children: api
          .enumerate(w.hwnd)
          .filter((c) =>
            [
              'SHELLDLL_DefView',
              'SysListView32',
              'TrayShowDesktopButton',
              'Windows.UI.Composition.DesktopWindowContentBridge'
            ].includes(c.className)
          )
      }))
    }
  }
  api.pixel = (x, y) => {
    const dc = api.getDC(0)
    if (!dc) throw new Error('GetDC(screen) failed')
    try {
      const value = api.getPixel(dc, x, y)
      if (value === 0xffffffff) throw new Error('GetPixel(screen) failed')
      return { r: value & 255, g: (value >>> 8) & 255, b: (value >>> 16) & 255 }
    } finally {
      api.releaseDC(0, dc)
    }
  }
  return api
}

module.exports = { createWin32 }
if (require.main === module) console.log(JSON.stringify(createWin32().inventory(), null, 2))
