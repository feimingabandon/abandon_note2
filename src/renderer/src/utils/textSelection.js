export function readTextSelection(root, contentValue = '') {
  const selection = window.getSelection?.()
  if (!root || !selection || selection.rangeCount !== 1 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const containsNode = (node) => {
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentNode : node
    return element === root || root.contains(element)
  }
  if (!containsNode(range.startContainer) || !containsNode(range.endContainer)) return null

  const prefix = document.createRange()
  prefix.selectNodeContents(root)
  prefix.setEnd(range.startContainer, range.startOffset)
  const start = prefix.toString().length
  const text = range.toString()
  const end = start + text.length
  const content = String(contentValue ?? '')
  if (!text.trim() || content.slice(start, end) !== text) return null
  return { start, end, text, rect: range.getBoundingClientRect() }
}
