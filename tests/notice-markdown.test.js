import { describe, it, expect } from 'vitest'
import {
  renderNoticeMarkdown,
  safeMarkdownUrl
} from '../src/renderer/src/components/markdown/notice-markdown.js'

describe('通知与更新共用 Markdown', () => {
  it('保留首行缩进代码块的 Markdown 语义', () => {
    expect(renderNoticeMarkdown('    const value = 1\n')).toContain(
      '<pre><code>const value = 1\n</code></pre>'
    )
  })
  it('支持段落、换行、标题、强调、列表、引用、代码和表格', () => {
    const html = renderNoticeMarkdown(
      '# 标题\n\n**粗体** *斜体* ~~删除~~\n换行\n\n- 项目\n\n> 引用\n\n`代码`\n\n```js\nconst x = 1\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |'
    )
    for (const tag of ['h1', 'strong', 'em', 's', 'br', 'ul', 'blockquote', 'code', 'pre', 'table'])
      expect(html).toContain(`<${tag}`)
  })
  it('保留独立 HTTPS 图片域名并生成可键盘操作的放大入口', () => {
    const html = renderNoticeMarkdown('![说明](https://release-images.example/image.png)')
    expect(html).toContain('src="https://release-images.example/image.png"')
    expect(html).toContain('type="button"')
    expect(html).toContain('referrerpolicy="no-referrer"')
  })
  it('原始 HTML 和事件属性不能执行，图片标题无法注入属性', () => {
    const html = renderNoticeMarkdown(
      '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n![" onerror="alert(1)](https://example.com/a.png)'
    )
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain(' onerror="')
    expect(html).toContain('&lt;script&gt;')
  })
  it.each([
    'javascript:alert(1)',
    'file:///c:/secret.png',
    'data:image/svg+xml,test',
    '//example.com/a.png',
    'http://example.com/a.png',
    'https://user:pass@example.com/a'
  ])('拒绝非公开 HTTPS 图片地址 %s', (url) => {
    expect(safeMarkdownUrl(url, true)).toBe('')
    expect(renderNoticeMarkdown(`![图片](${url})`)).not.toContain('<img ')
  })
  it('链接使用系统浏览器入口所支持的协议，拒绝其他协议', () => {
    expect(renderNoticeMarkdown('[链接](https://example.com)')).toContain(
      'target="_blank" rel="noopener noreferrer"'
    )
    expect(renderNoticeMarkdown('[链接](javascript:alert%281%29)')).not.toContain(
      'href="javascript:'
    )
    expect(renderNoticeMarkdown('[链接](relative/path)')).not.toContain('href=')
  })
})
