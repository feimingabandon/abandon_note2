import { describe, expect, it } from 'vitest'
import { captureIpcArguments } from '../src/main/logging/ipc-arguments.js'

describe('captureIpcArguments', () => {
  it('preserves useful ordinary IPC context', () => {
    expect(captureIpcArguments([{ id: 7, fields: { content: '正文', isPinned: true } }])).toEqual([
      { id: 7, fields: { content: '正文', isPinned: true } }
    ])
  })

  it('omits large Base64 fields before serializing the log payload', () => {
    const captured = captureIpcArguments([
      {
        id: 7,
        addedImages: [{ base64: 'A'.repeat(5 * 1024 * 1024), ext: 'png' }]
      }
    ])

    expect(captured[0].addedImages[0]).toEqual({
      base64: {
        omitted: true,
        type: 'string',
        length: 5 * 1024 * 1024
      },
      ext: 'png'
    })
    expect(JSON.stringify(captured).length).toBeLessThan(100_000)
  })

  it('bounds large plain text while retaining an error-relevant preview', () => {
    const captured = captureIpcArguments([{ content: '便'.repeat(200_000) }])
    expect(captured[0].content).toMatchObject({
      truncated: true,
      originalLength: 200_000
    })
    expect(captured[0].content.preview.length).toBe(20_000)
  })
})
