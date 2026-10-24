import { describe, expect, it, vi } from 'vitest'
import { parseDraftJournal } from '../src/renderer/src/utils/draftAssets.js'
import {
  convertLegacyDraft,
  findLegacyCaptureConflict,
  hashLegacyDraft,
  isKnownLegacyDraftKey,
  LEGACY_CAPTURE_CONFLICT,
  legacyDraftKey,
  legacyMigrationReceipt,
  parseLegacyDraft
} from '../src/renderer/src/utils/legacyDraftAssets.js'

const session = 'editing-launch'
const image = { base64: 'AQID', ext: 'png', name: 'retained.png', size: 3 }
const asset = { assetId: 'owned-image', ext: 'png', name: 'retained.png', size: 3 }
const pending = {
  sessionId: 'capture-session',
  deliveryId: 'delivery',
  token: 'old-capture-token',
  action: 'note',
  width: 1,
  height: 1,
  size: 3,
  dataUrl: 'data:image/png;base64,AQID'
}
const raw = (data) => JSON.stringify({ updatedAt: 123, data })
function journal(key, data, migration) {
  return JSON.stringify({
    version: 3,
    sessionId: session,
    key,
    owner: { sessionId: session, key, ownerId: 'owner', generation: 1 },
    data,
    ...(migration ? { migration } : {})
  })
}
const v3key = (key) => `abandon:editing-draft:v3:${session}:${key}`
function storage(entries) {
  return { getItem: (key) => entries.get(key) ?? null }
}

describe('known launch-scoped v2 draft conversion', () => {
  it('recognizes only the verified producer keys', () => {
    for (const key of [
      'new:list',
      'new:capture',
      'note:14',
      'new:calendar:2026-10-22',
      'quick:14',
      'template:new',
      'template:14',
      'calendar:quick',
      'capture:pending-delivery'
    ])
      expect(isKnownLegacyDraftKey(key), key).toBe(true)
    for (const key of [
      'editor',
      'note:0',
      'note:any',
      'note:9007199254740992',
      'template:',
      'new:other',
      'new:calendar:2026-02-30'
    ])
      expect(() => parseLegacyDraft(raw({}), key), key).toThrow()
  })

  it.each([
    '{"version":2,"updatedAt":123,"data":{}}',
    '{"data":{}}',
    '{"updatedAt":"123","data":{}}',
    '{"updatedAt":123,"data":[]}',
    '{"updatedAt":123,"data":{"unknown":{"dataUrl":"retained"}}}'
  ])('rejects an unverified wrapper or payload without rewriting it: %s', (source) => {
    expect(() => parseLegacyDraft(source, 'new:list')).toThrow()
    expect(source).toContain('data')
  })

  it.each([
    [
      'new:list',
      {
        content: '正文',
        remark: '备注',
        contentColorRanges: [],
        effectiveAt: '2026-10-22 09:00',
        statusChoice: 'unfinished',
        finishedAt: '',
        cleanEffectiveAt: false,
        cleanFinishedAt: false,
        durationKind: 'until_completed',
        durationDays: 3,
        reminderChannels: ['popup'],
        isPinned: true,
        tagIds: [4]
      }
    ],
    ['new:capture', { content: '截图说明', remark: '截图备注', durationKind: 'until_completed' }],
    [
      'note:7',
      {
        content: '正文',
        remark: '备注',
        contentColorRanges: [],
        statusChoice: 'unfinished',
        effectiveAt: '2026-10-22 09:00',
        finishedAt: '',
        durationKind: 'until_completed',
        durationDays: 3,
        reminderChannels: ['popup'],
        pendingReminderTime: '09:00',
        pendingReminderCancelled: false,
        isPinned: true,
        tagIds: [4],
        initialVersion: 7
      }
    ],
    [
      'quick:7',
      { draft: '正文', remarkDraft: '备注', originalContent: '原正文', originalRemark: '原备注' }
    ],
    [
      'new:calendar:2026-10-22',
      {
        content: '正文',
        remark: '备注',
        contentColorRanges: [],
        time: '09:00',
        timeDirty: true,
        immediateIntent: false,
        statusChoice: 'unfinished',
        finishedAt: '',
        durationKind: 'until_completed',
        durationDays: 3,
        reminderChannels: ['popup'],
        isPinned: true,
        tagIds: [4]
      }
    ],
    [
      'template:new',
      {
        content: '模板',
        frequency: 'weekly',
        interval: 2,
        weekdays: [1, 3],
        monthDays: [22],
        quarterMonth: 1,
        quarterDays: [22],
        yearDates: ['10-22'],
        timeOfDay: '09:00',
        startAt: '2026-10-22',
        endAt: '2026-12-22',
        reminderChannels: ['popup'],
        isPinned: true,
        tagIds: [4]
      }
    ],
    [
      'calendar:quick',
      {
        drafts: [
          ['2026-10-22', '日历正文'],
          ['2026-10-23', '另一条目']
        ]
      }
    ]
  ])(
    'keeps the verified %s producer values and comparison/time intent intact',
    async (key, data) => {
      const stage = vi.fn()
      expect(await convertLegacyDraft(parseLegacyDraft(raw(data), key), stage)).toEqual(data)
      expect(stage).not.toHaveBeenCalled()
    }
  )

  it('preserves MonthCreator absence of immediateIntent for its existing false-default restoration', async () => {
    const stage = vi.fn()
    const month = parseLegacyDraft(raw({ content: '缺省规则' }), 'new:calendar:2026-10-22')
    expect(Object.hasOwn(await convertLegacyDraft(month, stage), 'immediateIntent')).toBe(false)
  })

  it.each([
    ['new:list', { futureField: 'must keep' }],
    ['new:capture', { captureReceipts: [] }],
    ['note:7', { originalContent: 'belongs to quick only' }],
    ['quick:7', { content: 'belongs to note only' }],
    ['new:calendar:2026-10-22', { effectiveAt: 'belongs to note only' }],
    ['template:new', { attachments: { addedImages: [image], deletedImageIds: [] } }],
    ['calendar:quick', { content: 'must keep' }],
    ['capture:pending-delivery', { content: 'must keep' }]
  ])('rejects unknown %s data instead of allowing a later form flush to drop it', (key, data) => {
    const source = raw(data)
    expect(() => parseLegacyDraft(source, key)).toThrow('原始记录仍保留')
    expect(JSON.parse(source).data).toEqual(data)
  })

  it('stages images sequentially and replaces only the verified image locations', async () => {
    const data = {
      content: 'retained',
      attachments: { addedImages: [image, { ...image, name: 'second.png' }], deletedImageIds: [3] }
    }
    let finishFirst
    const first = new Promise((resolve) => (finishFirst = resolve))
    const stage = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ...asset, assetId: 'two' })
    const converting = convertLegacyDraft(parseLegacyDraft(raw(data), 'new:list'), stage)
    expect(stage).toHaveBeenCalledTimes(1)
    finishFirst(asset)
    const converted = await converting
    expect(stage).toHaveBeenCalledTimes(2)
    expect(converted).toEqual({
      content: data.content,
      attachments: { addedImages: [asset, { ...asset, assetId: 'two' }], deletedImageIds: [3] }
    })
    expect(data.attachments.addedImages[0]).toEqual(image)
  })

  it('keeps capture identity distinct from the editing launch and drops the obsolete token', async () => {
    const stage = vi.fn(async () => asset)
    const data = parseLegacyDraft(raw({ pendingAsset: pending }), 'capture:pending-delivery')
    expect(await convertLegacyDraft(data, stage)).toEqual({
      pendingAsset: {
        sessionId: pending.sessionId,
        deliveryId: 'delivery',
        action: 'note',
        image: asset
      }
    })
    expect(stage).toHaveBeenCalledWith({ base64: pending.dataUrl, ext: 'png', size: 3 })
    expect(data.pendingAsset.token).toBe('old-capture-token')
  })

  it.each([
    ['new:list', { attachments: { addedImages: [asset], deletedImageIds: [] } }],
    ['new:list', { attachments: { addedImages: [image], deletedImageIds: ['3'] } }],
    [
      'new:list',
      { attachments: { addedImages: [{ ...image, capability: 'unknown' }], deletedImageIds: [] } }
    ],
    ['capture:pending-delivery', { pendingAsset: { ...pending, action: 'unknown' } }],
    ['capture:pending-delivery', { pendingAsset: { ...pending, dataUrl: 'file:///original.png' } }]
  ])('rejects an unknown legacy image shape %# at its real producer location', (key, data) => {
    expect(() => parseLegacyDraft(raw(data), key)).toThrow()
  })

  it('binds the exact UTF-8 source bytes to a strict migration receipt', async () => {
    const source = raw({ content: '原文' })
    const hash = await hashLegacyDraft(source)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(await hashLegacyDraft(source + ' ')).not.toBe(hash)
    const receipt = legacyMigrationReceipt(session, 'new:list', hash, {})
    expect(
      parseDraftJournal(journal('new:list', {}, receipt), session, 'new:list').migration
    ).toEqual(receipt)
    for (const change of [
      { phase: 'unknown' },
      { sourceHash: 'guess' },
      { sourceHash: ['a'.repeat(64)] },
      { sourceKey: legacyDraftKey('other', 'new:list') },
      { secret: 'unverified' }
    ])
      expect(() =>
        parseDraftJournal(journal('new:list', {}, { ...receipt, ...change }), session, 'new:list')
      ).toThrow()
    expect(() =>
      parseDraftJournal(journal('new:list', { content: 'partial' }, receipt), session, 'new:list')
    ).toThrow()
  })
})

describe('legacy screenshot source/target ambiguity', () => {
  function entries() {
    return new Map([
      [
        legacyDraftKey(session, 'new:capture'),
        raw({ attachments: { addedImages: [image], deletedImageIds: [] } })
      ],
      [legacyDraftKey(session, 'capture:pending-delivery'), raw({ pendingAsset: pending })]
    ])
  }

  it('preserves two old sources and never infers delivery from identical bytes', () => {
    const source = entries(),
      before = [...source]
    expect(findLegacyCaptureConflict(storage(source), session)).toBe(LEGACY_CAPTURE_CONFLICT)
    expect([...source]).toEqual(before)
    expect(findLegacyCaptureConflict(storage(source), 'another-launch')).toBeNull()
  })

  it.each(['staging', 'complete'])('retains %s legacy provenance after raw removal', (phase) => {
    const source = entries()
    source.delete(legacyDraftKey(session, 'capture:pending-delivery'))
    const receipt = {
      ...legacyMigrationReceipt(session, 'capture:pending-delivery', 'a'.repeat(64), {
        pendingAsset: pending
      }),
      phase
    }
    source.set(
      v3key('capture:pending-delivery'),
      journal(
        'capture:pending-delivery',
        phase === 'complete'
          ? {
              pendingAsset: {
                sessionId: pending.sessionId,
                deliveryId: pending.deliveryId,
                action: 'note',
                image: asset
              }
            }
          : {},
        receipt
      )
    )
    expect(findLegacyCaptureConflict(storage(source), session)).toBe(LEGACY_CAPTURE_CONFLICT)
  })

  it('accepts only a matching target receipt whose asset exists in target metadata', () => {
    const source = entries()
    const target = {
      attachments: { addedImages: [asset], deletedImageIds: [] },
      captureReceipts: [
        { sessionId: pending.sessionId, deliveryId: pending.deliveryId, assetId: asset.assetId }
      ]
    }
    source.set(v3key('new:capture'), journal('new:capture', target))
    expect(findLegacyCaptureConflict(storage(source), session)).toBeNull()
    for (const change of [{ sessionId: session }, { deliveryId: 'other' }, { assetId: 'absent' }]) {
      source.set(
        v3key('new:capture'),
        journal('new:capture', {
          ...target,
          captureReceipts: [{ ...target.captureReceipts[0], ...change }]
        })
      )
      expect(findLegacyCaptureConflict(storage(source), session)).toBe(LEGACY_CAPTURE_CONFLICT)
    }
  })

  it('does not treat a background delivery or one modern source as a legacy duplicate', () => {
    const source = entries()
    source.set(
      legacyDraftKey(session, 'capture:pending-delivery'),
      raw({ pendingAsset: { ...pending, action: 'background' } })
    )
    expect(findLegacyCaptureConflict(storage(source), session)).toBeNull()
    source.delete(legacyDraftKey(session, 'capture:pending-delivery'))
    source.set(
      v3key('capture:pending-delivery'),
      journal('capture:pending-delivery', {
        pendingAsset: {
          sessionId: pending.sessionId,
          deliveryId: pending.deliveryId,
          action: 'note',
          image: asset
        }
      })
    )
    expect(findLegacyCaptureConflict(storage(source), session)).toBeNull()
  })
})
