import { describe, expect, it } from 'vitest'
import { getWindowProfile } from '../src/main/windows/window-profiles.js'

describe('main window profiles', () => {
  it('keeps renderer and settings scopes separate while exposing all configurable dock edges', () => {
    expect(getWindowProfile('list')).toMatchObject({
      settingsScope: 'main',
      rendererFile: 'index.html',
      supportedDockEdges: ['top', 'left', 'right']
    })
    expect(getWindowProfile('month')).toMatchObject({
      settingsScope: 'month',
      rendererFile: 'month.html',
      supportedDockEdges: ['top', 'left', 'right'],
      defaultCentered: true
    })
    expect(getWindowProfile('week')).toMatchObject({
      settingsScope: 'week',
      rendererFile: 'week.html',
      logRole: 'week',
      supportedDockEdges: ['top', 'left', 'right'],
      defaultCentered: true
    })
  })
})
