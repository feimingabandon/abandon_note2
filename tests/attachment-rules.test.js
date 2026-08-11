import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENT_BATCH_BYTES,
  assertAttachmentBatchWithinLimit,
  getBase64DecodedSize
} from '../src/shared/attachment-rules.js'

describe('attachment rules', () => {
  it('computes padded and unpadded base64 sizes without decoding the payload', () => {
    expect(getBase64DecodedSize('YQ==')).toBe(1)
    expect(getBase64DecodedSize('YWI=')).toBe(2)
    expect(getBase64DecodedSize('YWJj')).toBe(3)
  })

  it('rejects malformed base64 and oversized batches', () => {
    expect(() => getBase64DecodedSize('%%%')).toThrow(/格式无效/)
    expect(() =>
      assertAttachmentBatchWithinLimit([{ size: MAX_ATTACHMENT_BATCH_BYTES }, { size: 1 }], {
        trustDeclaredSize: true
      })
    ).toThrow(/200MB/)
  })

  it('enforces the available image count for an existing note', () => {
    expect(() =>
      assertAttachmentBatchWithinLimit([{ size: 1 }, { size: 1 }], {
        maxCount: 1,
        trustDeclaredSize: true
      })
    ).toThrow(/最多添加 1 张/)
  })
})
