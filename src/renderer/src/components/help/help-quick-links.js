import { helpArticles } from './help-content.js'

export const HELP_QUICK_LINK_IDS = Object.freeze([
  'notes-create',
  'note-duration',
  'window-dock',
  'safety-troubleshoot'
])

export function resolveHelpQuickLinks(articles = helpArticles) {
  // A removed article must not prevent the rest of Help Center from rendering.
  // Tests also validate the configured IDs so this fallback cannot hide stale links in CI.
  return HELP_QUICK_LINK_IDS.map((id) => articles.find((article) => article.id === id)).filter(
    Boolean
  )
}
