const koffi = require('koffi')
const user32 = koffi.load('user32.dll')
const create = user32.func(
  'intptr_t CreateWindowExW(uint32_t exStyle, str16 className, str16 title, uint32_t style, int x, int y, int w, int h, intptr_t parent, intptr_t menu, intptr_t instance, void *param)'
)
const destroy = user32.func('int DestroyWindow(intptr_t hwnd)')
const notify = user32.func(
  'void NotifyWinEvent(uint32_t event, intptr_t hwnd, int32_t objectId, int32_t childId)'
)
const hwnd = create(0, 'STATIC', 'Abandon z-order test', 0x80000000, 0, 0, 1, 1, 0, 0, 0, null)
if (!hwnd) throw new Error('Cannot create the external event source')
process.on('message', async ({ objectId, childId, count }) => {
  for (let i = 0; i < count; i++) {
    notify(0x8004, hwnd, objectId, childId)
    await new Promise((done) => setTimeout(done, 10))
  }
  process.send({ done: true })
})
process.on('disconnect', () => {
  destroy(hwnd)
  process.exit(0)
})
process.send({ ready: true })
