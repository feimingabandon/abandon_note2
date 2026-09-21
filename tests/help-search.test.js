import { describe, expect, it } from 'vitest'
import { helpArticles, helpGroups } from '../src/renderer/src/components/help/help-content.js'
import {
  articleText,
  helpSearchTerms,
  highlightHelp,
  searchHelp
} from '../src/renderer/src/components/help/help-search.js'

describe('帮助全文搜索', () => {
  it('正文与多关键词跨字段匹配，并优先返回标题命中', () => {
    expect(searchHelp(helpArticles, '新建便签')[0].id).toBe('notes-create')
    expect(searchHelp(helpArticles, '00:01')[0].id).toBe('notes-create')
    expect(searchHelp(helpArticles, '持续到完成 跨日').map((result) => result.id)).toContain(
      'note-duration'
    )
    expect(searchHelp(helpArticles, '持续方式 不存在的关键词')).toEqual([])
    expect(searchHelp(helpArticles, '　ｘｌｓｘ　')[0].id).toBe('tools-report')
    expect(searchHelp(helpArticles, '1160653906')[0].id).toBe('safety-support')
    expect(searchHelp(helpArticles, '   ')).toEqual([])
  })
  it('正文摘要包含实际匹配，并处理大小写、重复词和特殊字符', () => {
    expect(helpSearchTerms(' Excel  EXCEL\n日志 ')).toEqual(['excel', '日志'])
    expect(searchHelp(helpArticles, '00:01')[0].excerpt).toContain('00:01')
    const text = '<script> a+b (x) XLSX'
    const parts = highlightHelp(text, '<script> a+b (x) xlsx')
    expect(parts.map((part) => part.text).join('')).toBe(text)
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual([
      '<script>',
      'a+b',
      '(x)',
      'XLSX'
    ])
  })
  it('全部功能入口唯一，功能文档覆盖新建方式和持续方式边界', () => {
    expect(new Set(helpArticles.map((article) => article.id)).size).toBe(helpArticles.length)
    for (const article of helpArticles)
      expect(helpGroups.some((group) => group.id === article.group)).toBe(true)
    const create = articleText(helpArticles.find((article) => article.id === 'notes-create'))
    for (const entry of [
      '便签列表',
      '快速新建',
      '日期格右键新建',
      '日期侧栏新建',
      '按周期自动生成'
    ])
      expect(create).toContain(entry)
    const duration = articleText(helpArticles.find((article) => article.id === 'note-duration'))
    for (const rule of ['默认选择「仅当天」', '2～365 天', '完成日期固定结束日', '旧便签'])
      expect(duration).toContain(rule)
    expect(articleText(helpArticles.find((article) => article.id === 'tools-report'))).toContain(
      '366'
    )
  })
})
