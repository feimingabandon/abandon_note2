function normalizedText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function errorText(error) {
  if (!error) return ''
  if (typeof error === 'string') return error.trim()

  const stack = normalizedText(error.stack)
  if (stack) return stack

  const message = normalizedText(error.message)
  if (!message) return ''
  const name = normalizedText(error.name)
  return name && name !== 'Error' ? `${name}: ${message}` : message
}

/**
 * 日志查看器只呈现对用户排查有意义的文字。会话、进程、版本和 metadata
 * 仍保留在原始日志文件中，但不混入界面的展开详情。
 */
export function formatLogRecordText(record = {}) {
  const message = normalizedText(record.message)
  const error = errorText(record.error)

  if (!error) return message || '无消息'
  if (!message || error === message || error.includes(message)) return error
  return `${message}\n\n${error}`
}
