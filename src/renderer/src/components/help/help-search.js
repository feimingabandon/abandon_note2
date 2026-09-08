export function helpSearchTerms(query) {
  return [
    ...new Set(
      String(query || '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
    )
  ]
}

export function articleText(article) {
  return [
    article.summary,
    ...article.blocks.flatMap((block) => [
      block.title || '',
      ...(block.paragraphs || []),
      ...(block.rows || []).map((row) => row.join('：'))
    ])
  ].join('\n')
}

export function searchHelp(articles, query) {
  const terms = helpSearchTerms(query)
  if (!terms.length) return []
  const normalize = (text) => text.normalize('NFKC').toLocaleLowerCase()
  return articles
    .flatMap((article, order) => {
      const body = articleText(article)
      const title = normalize(article.title)
      const haystack = normalize(`${article.title}\n${body}\n${article.keywords || ''}`)
      if (!terms.every((term) => haystack.includes(term))) return []
      const lines = body.split('\n').filter(Boolean)
      const excerpt =
        lines
          .map((line) => ({
            line,
            score: terms.filter((term) => normalize(line).includes(term)).length
          }))
          .sort((a, b) => b.score - a.score)[0]?.line || article.summary
      return [
        {
          ...article,
          excerpt,
          score: terms.reduce((n, term) => n + (title.includes(term) ? 10 : 0), 0),
          order
        }
      ]
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
}

/** 按字面值标记命中，返回文本片段而非 HTML；正则符号同样作为普通关键词。 */
export function highlightHelp(text, query) {
  const terms = helpSearchTerms(query).sort((a, b) => b.length - a.length)
  if (!terms.length) return [{ text, match: false }]
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const expression = new RegExp(escaped.join('|'), 'giu')
  const parts = []
  let offset = 0
  for (const match of text.matchAll(expression)) {
    if (match.index > offset) parts.push({ text: text.slice(offset, match.index), match: false })
    parts.push({ text: match[0], match: true })
    offset = match.index + match[0].length
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), match: false })
  return parts
}
