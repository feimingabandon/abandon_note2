import { describe, expect, it } from 'vitest'
import { getWindowProfile } from '../src/main/windows/window-profiles.js'

describe('main window profiles', () => {
  it('keeps renderer, settings scope and dock axes separate', () => {
    expect(getWindowProfile('list')).toMatchObject({
      settingsScope: 'main',
      rendererFile: 'index.html',
      dockEdges: ['left', 'right']
    })
    expect(getWindowProfile('month')).toMatchObject({
      settingsScope: 'month',
      rendererFile: 'month.html',
      dockEdges: ['top'],
      defaultCentered: true
    })
  })
})
