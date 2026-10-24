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

  it('names metadata journals by launch session and only cleans recognized v3 records', () => {
    const drafts = read('src/renderer/src/composables/useDraftProtection.js')
    const assets = read('src/renderer/src/utils/draftAssets.js')
    expect(drafts).toContain('const PREFIX = `${EDITING_DRAFT_PREFIX}v3:${sessionId}:`')
    expect(drafts).toContain('removePreviousDraftSessions(localStorage, sessionId)')
    expect(assets).toContain('parseDraftJournal(JSON.stringify(value), value.sessionId, value.key)')
    expect(assets).not.toContain('!key.startsWith(PREFIX)')
    expect(drafts).toContain('localStorage.setItem(')
  })
})
