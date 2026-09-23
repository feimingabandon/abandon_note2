import { describe, expect, it } from 'vitest'
import { helpArticles } from '../src/renderer/src/components/help/help-content.js'
import {
  HELP_QUICK_LINK_IDS,
  resolveHelpQuickLinks
} from '../src/renderer/src/components/help/help-quick-links.js'

describe('帮助首页快捷入口', () => {
  it('配置的每个入口必须对应现有文章，且不重复', () => {
    expect(new Set(HELP_QUICK_LINK_IDS).size).toBe(HELP_QUICK_LINK_IDS.length)
    for (const id of HELP_QUICK_LINK_IDS) {
      expect(
        helpArticles.find((article) => article.id === id),
        `失效的帮助入口：${id}`
      ).toBeDefined()
    }
    expect(resolveHelpQuickLinks().map((article) => article.id)).toEqual(HELP_QUICK_LINK_IDS)
  })

  it('以持续方式帮助替代已删除的移动便签文章', () => {
    expect(HELP_QUICK_LINK_IDS).not.toContain('notes-move')
    expect(resolveHelpQuickLinks().find((article) => article.id === 'note-duration')?.title).toBe(
      '便签持续方式'
    )
  })

  it('文章缺失时只省略该入口，不把 undefined 交给页面渲染', () => {
    const remaining = helpArticles.filter((article) => article.id !== 'note-duration')
    expect(resolveHelpQuickLinks(remaining).map((article) => article.id)).toEqual([
      'notes-create',
      'window-dock',
      'safety-troubleshoot'
    ])
    expect(resolveHelpQuickLinks([])).toEqual([])
  })
})
