import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('editing draft launch session', () => {
  it('passes one launch-scoped identifier from main to the renderer', () => {
    const main = read('src/main/index.js')
    const preload = read('src/preload/index.js')

    expect(main).toContain('const editingDraftSessionId = randomUUID()')
    expect(main).toContain(
      'additionalArguments: [`--editing-draft-session=${editingDraftSessionId}`]'
    )
    expect(preload).toContain("argument.startsWith('--editing-draft-session=')")
    expect(preload).toContain('editingDraftSessionId')
  })

  it('names drafts by launch session and removes records from older launches', () => {
    const drafts = read('src/renderer/src/composables/useDraftProtection.js')

    expect(drafts).toContain('const PREFIX = `${DRAFT_PREFIX}v2:${sessionId}:`')
    expect(drafts).toContain('key.startsWith(DRAFT_PREFIX) && !key.startsWith(PREFIX)')
    expect(drafts).toContain('localStorage.removeItem(key)')
    expect(drafts).toContain('localStorage.setItem(')
  })
})
