import { describe, expect, it } from 'vitest'
import { formatLogRecordText } from '../src/renderer/src/utils/logRecordText.js'

describe('log record text', () => {
  it('shows the complete message without diagnostic parameters', () => {
    expect(
      formatLogRecordText({
        message: '[update] 检查完成：当前版本已是最新版本',
        metadata: { provider: 'gitcode' },
        sessionId: 'session-id',
        pid: 1234,
        versions: { electron: '43.2.0' }
      })
    ).toBe('[update] 检查完成：当前版本已是最新版本')
  })

  it('uses a complete error stack without repeating its message', () => {
    expect(
      formatLogRecordText({
        message: '读取设置失败',
        error: {
          message: '读取设置失败',
          stack: 'Error: 读取设置失败\n    at loadSettings (settings.js:10:3)'
        }
      })
    ).toBe('Error: 读取设置失败\n    at loadSettings (settings.js:10:3)')
  })

  it('keeps distinct context before an error stack', () => {
    expect(
      formatLogRecordText({
        message: '设置页面初始化失败',
        error: {
          stack: 'TypeError: value is undefined\n    at initialize (settings.js:20:5)'
        }
      })
    ).toBe(
      '设置页面初始化失败\n\nTypeError: value is undefined\n    at initialize (settings.js:20:5)'
    )
  })
})
