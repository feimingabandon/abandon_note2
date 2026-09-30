import { describe, expect, it } from 'vitest'
import { createModalQueue } from '../src/renderer/src/utils/modalQueue.js'

describe('window modal FIFO', () => {
  it('retains the active ticket until close completes and serves arrivals in order', () => {
    const queue = createModalQueue()
    const shown = []
    const closeEditor = queue.enqueue(() => shown.push('editor'))
    const closeNotice = queue.enqueue(() => shown.push('notice'))
    const closeUpdate = queue.enqueue(() => shown.push('update'))
    expect(shown).toEqual(['editor'])
    closeEditor()
    expect(shown).toEqual(['editor', 'notice'])
    closeEditor()
    expect(shown).toEqual(['editor', 'notice'])
    closeNotice()
    expect(shown).toEqual(['editor', 'notice', 'update'])
    closeUpdate()
  })

  it('cancels a waiting request without disturbing the active dialog', () => {
    const queue = createModalQueue()
    const shown = []
    const close = queue.enqueue(() => shown.push('first-use'))
    const cancel = queue.enqueue(() => shown.push('deleted-note'))
    queue.enqueue(() => shown.push('update'))
    cancel()
    expect(shown).toEqual(['first-use'])
    close()
    expect(shown).toEqual(['first-use', 'update'])
  })

  it('allows dependent confirmations to finish before advancing independent dialogs', () => {
    const queue = createModalQueue()
    const shown = []
    const closeEditor = queue.enqueue(() => shown.push('editor'))
    const confirm = queue.hold()
    const preview = queue.hold()
    queue.enqueue(() => shown.push('notice'))
    closeEditor()
    confirm()
    confirm()
    expect(shown).toEqual(['editor'])
    preview()
    expect(shown).toEqual(['editor', 'notice'])
  })

  it('does not open background notices over a standalone confirmation', () => {
    const queue = createModalQueue()
    const release = queue.hold()
    let opened = false
    queue.enqueue(() => {
      opened = true
    })
    expect(opened).toBe(false)
    release()
    expect(opened).toBe(true)
  })
})
