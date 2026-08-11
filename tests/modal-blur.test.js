import { afterEach, describe, expect, it, vi } from 'vitest'

import { retainModalBlur } from '../src/renderer/src/utils/modalBlur.js'

function createElement(zIndex = 'auto') {
  const classes = new Set()
  return {
    zIndex,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('modal background blur manager', () => {
  it('blurs the application scene for the first modal and releases idempotently', () => {
    const scene = createElement()
    vi.stubGlobal('document', {
      querySelectorAll: () => [],
      querySelector: () => scene
    })
    vi.stubGlobal('window', { getComputedStyle: (element) => ({ zIndex: element.zIndex }) })

    const release = retainModalBlur()
    expect(scene.classList.contains('is-ui-background-blurred')).toBe(true)

    release()
    release()
    expect(scene.classList.contains('is-ui-background-blurred')).toBe(false)
  })

  it('blurs only the highest existing modal layer when another modal is nested', () => {
    const settings = createElement('2')
    const editor = createElement('4')
    vi.stubGlobal('document', {
      querySelectorAll: () => [settings, editor],
      querySelector: () => null
    })
    vi.stubGlobal('window', { getComputedStyle: (element) => ({ zIndex: element.zIndex }) })

    const release = retainModalBlur()
    expect(settings.classList.contains('is-ui-background-blurred')).toBe(false)
    expect(editor.classList.contains('is-ui-background-blurred')).toBe(true)

    release()
    expect(editor.classList.contains('is-ui-background-blurred')).toBe(false)
  })
})
