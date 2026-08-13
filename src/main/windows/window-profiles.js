import { VIEW_MODES } from '../../shared/settings-schema.js'

export const WINDOW_PROFILES = Object.freeze({
  [VIEW_MODES.LIST]: Object.freeze({
    viewMode: VIEW_MODES.LIST,
    settingsScope: 'main',
    rendererFile: 'index.html',
    logRole: 'main',
    dockEdges: Object.freeze(['left', 'right']),
    defaultCentered: false
  }),
  [VIEW_MODES.MONTH]: Object.freeze({
    viewMode: VIEW_MODES.MONTH,
    settingsScope: 'month',
    rendererFile: 'month.html',
    logRole: 'month',
    dockEdges: Object.freeze(['top']),
    defaultCentered: true
  }),
  [VIEW_MODES.WEEK]: Object.freeze({
    viewMode: VIEW_MODES.WEEK,
    settingsScope: 'week',
    rendererFile: 'week.html',
    logRole: 'week',
    dockEdges: Object.freeze(['top']),
    defaultCentered: true
  })
})

export function getWindowProfile(viewMode) {
  return WINDOW_PROFILES[viewMode] || WINDOW_PROFILES[VIEW_MODES.LIST]
}
