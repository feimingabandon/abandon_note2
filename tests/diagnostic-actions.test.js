import { describe, expect, it } from 'vitest'
import {
  diagnosticErrorCode,
  diagnosticEventForChannel,
  summarizeDiagnosticArguments
} from '../src/shared/diagnostic-actions.js'

describe('diagnostic action definitions', () => {
  it('maps mutating user operations but leaves read-only queries quiet', () => {
    expect(diagnosticEventForChannel('notes:save-draft')).toBe('note.save')
    expect(diagnosticEventForChannel('templates:pause')).toBe('template.pause')
    expect(diagnosticEventForChannel('set-setting-value')).toBe('settings.value.set')
    expect(diagnosticEventForChannel('notes:get')).toBeNull()
    expect(diagnosticEventForChannel('calendar:get-month')).toBeNull()
  })

  it('keeps structural context while omitting user content, credentials and binary payloads', () => {
    const [summary] = summarizeDiagnosticArguments([
      {
        id: 42,
        fields: { content: '便签正文', status: 'in_progress' },
        password: 'never-log-this',
        images: [{ base64: 'abc123', ext: 'png' }]
      }
    ])

    expect(summary).toMatchObject({
      id: 42,
      fields: {
        content: { omitted: true, reason: 'user-content', length: 4 },
        status: 'in_progress'
      },
      password: { omitted: true, reason: 'sensitive-or-binary' },
      images: [{ base64: { omitted: true, reason: 'sensitive-or-binary' }, ext: 'png' }]
    })
    expect(JSON.stringify(summary)).not.toContain('never-log-this')
    expect(JSON.stringify(summary)).not.toContain('便签正文')
  })

  it('normalizes clone failures to a stable error code', () => {
    expect(diagnosticErrorCode(new Error('An object could not be cloned.'))).toBe(
      'IPC_CLONE_FAILED'
    )
    expect(diagnosticErrorCode(Object.assign(new Error('保存失败'), { code: 'SAVE_FAILED' }))).toBe(
      'SAVE_FAILED'
    )
  })
})
