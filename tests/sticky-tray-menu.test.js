import { describe, expect, it, vi } from 'vitest'
import { buildStickyTrayTemplate } from '../src/main/sticky/StickyTrayMenu.js'

function createStickyService(stickies = [], recoverableCount = 0) {
  return {
    list: vi.fn(() => stickies),
    getRecoverableCount: vi.fn(() => recoverableCount),
    restoreMissing: vi.fn(async () => recoverableCount),
    focus: vi.fn(),
    close: vi.fn(),
    closeAll: vi.fn(),
    showAll: vi.fn()
  }
}

describe('sticky tray menu', () => {
  it('provides display and delete actions for each sticky', () => {
    const stickyService = createStickyService([{ id: 'sticky-1', preview: '测试便利贴' }])
    const template = buildStickyTrayTemplate({
      stickyService,
      openMainWindow: vi.fn(),
      quitApplication: vi.fn()
    })
    const overview = template.find((item) => item.label?.startsWith('便利贴总览'))
    const [displayAction, deleteAction] = overview.submenu[0].submenu

    displayAction.click()
    deleteAction.click()

    expect(stickyService.focus).toHaveBeenCalledWith('sticky-1')
    expect(stickyService.close).toHaveBeenCalledWith('sticky-1')
  })

  it('provides an enabled delete-all action only when stickies exist', () => {
    const stickyService = createStickyService([{ id: 'sticky-1', preview: '测试便利贴' }])
    const template = buildStickyTrayTemplate({
      stickyService,
      openMainWindow: vi.fn(),
      quitApplication: vi.fn()
    })
    const deleteAll = template.find((item) => item.label === '× 关闭全部便利贴')

    expect(deleteAll.enabled).toBe(true)
    deleteAll.click()
    expect(stickyService.closeAll).toHaveBeenCalledOnce()

    const emptyTemplate = buildStickyTrayTemplate({
      stickyService: createStickyService(),
      openMainWindow: vi.fn(),
      quitApplication: vi.fn()
    })
    expect(emptyTemplate.find((item) => item.label === '× 关闭全部便利贴').enabled).toBe(false)
  })

  it('restores missing persisted stickies from the tray', async () => {
    const stickyService = createStickyService([], 2)
    const template = buildStickyTrayTemplate({
      stickyService,
      openMainWindow: vi.fn(),
      quitApplication: vi.fn()
    })
    const restore = template.find((item) => item.label === '恢复便利贴（2）')

    expect(restore.enabled).toBe(true)
    restore.click()
    await vi.waitFor(() =>
      expect(stickyService.restoreMissing).toHaveBeenCalledWith({ source: 'tray' })
    )
    expect(stickyService.showAll).toHaveBeenCalledOnce()
    expect(template.find((item) => item.label === '× 关闭全部便利贴').enabled).toBe(true)
  })

  it('marks the active main view and switches through the tray submenu', () => {
    const switchMainView = vi.fn()
    const template = buildStickyTrayTemplate({
      stickyService: createStickyService(),
      openMainWindow: vi.fn(),
      activeViewMode: 'month',
      switchMainView,
      quitApplication: vi.fn()
    })
    const viewMenu = template.find((item) => item.label === '当前视图：月视图')

    expect(viewMenu.submenu.find((item) => item.label === '月视图').checked).toBe(true)
    viewMenu.submenu.find((item) => item.label === '便签列表').click()
    expect(switchMainView).toHaveBeenCalledWith('list')
  })

  it('offers and selects the week view', () => {
    const switchMainView = vi.fn()
    const template = buildStickyTrayTemplate({
      stickyService: createStickyService(),
      openMainWindow: vi.fn(),
      activeViewMode: 'week',
      switchMainView,
      quitApplication: vi.fn()
    })
    const viewMenu = template.find((item) => item.label === '当前视图：周视图')

    expect(viewMenu.submenu).toHaveLength(3)
    expect(viewMenu.submenu.find((item) => item.label === '周视图').checked).toBe(true)
    viewMenu.submenu.find((item) => item.label === '月视图').click()
    expect(switchMainView).toHaveBeenCalledWith('month')
  })
})
