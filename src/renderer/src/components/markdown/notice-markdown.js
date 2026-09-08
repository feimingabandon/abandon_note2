import MarkdownIt from 'markdown-it'

// Raw HTML is always text. Keep this renderer identical in the desktop and the
// separately built admin preview; never accept server-provided HTML.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false })
const escape = markdown.utils.escapeHtml

export function safeMarkdownUrl(value, image = false) {
  try {
    const raw = String(value || '')
    if (
      !/^https?:\/\//i.test(raw) ||
      [...raw].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
    )
      return ''
    const url = new URL(raw)
    if (url.username || url.password) return ''
    if (image && url.protocol !== 'https:') return ''
    return url.href
  } catch {
    return ''
  }
}

markdown.renderer.rules.link_open = (tokens, index) => {
  const href = safeMarkdownUrl(tokens[index].attrGet('href'))
  return href ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">` : '<a>'
}
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index]
  const alt = renderer.renderInlineAsText(token.children || [], options, env)
  const src = safeMarkdownUrl(token.attrGet('src'), true)
  if (!src)
    return `<span class="markdown-image-unavailable">${escape(alt || '图片地址不可用（需要 HTTPS 直链）')}</span>`
  // A single native button makes the image accessible to keyboard users too.
  return `<button type="button" class="markdown-image" aria-label="${escape(`放大图片：${alt || '通知图片'}`)}"><img src="${escape(src)}" alt="${escape(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><span class="markdown-image-error" hidden>${escape(alt || '图片')} · 加载失败，请检查网络或图片地址</span></button>`
}

export function renderNoticeMarkdown(source) {
  return markdown.render(String(source || '').slice(0, 200000))
}
