import { getDb } from './db-connection.js'

const UPDATE_COLUMNS = Object.freeze({
  boundsX: 'x',
  boundsY: 'y',
  boundsWidth: 'width',
  boundsHeight: 'height',
  displayId: 'display_id',
  workAreaX: 'work_area_x',
  workAreaY: 'work_area_y',
  workAreaWidth: 'work_area_width',
  workAreaHeight: 'work_area_height',
  fontSize: 'font_size',
  backgroundColor: 'background_color',
  cornerRadius: 'corner_radius',
  alwaysOnTop: 'always_on_top'
})

function toRecord(row) {
  if (!row) return null
  return {
    id: row.id,
    noteId: row.note_id,
    content: row.content_snapshot,
    bounds: {
      x: row.x,
      y: row.y,
      width: row.width,
      height: row.height
    },
    displayId: row.display_id,
    workArea:
      row.work_area_x === null ||
      row.work_area_y === null ||
      row.work_area_width === null ||
      row.work_area_height === null
        ? null
        : {
            x: row.work_area_x,
            y: row.work_area_y,
            width: row.work_area_width,
            height: row.work_area_height
          },
    fontSize: row.font_size,
    backgroundColor: row.background_color,
    cornerRadius: row.corner_radius,
    pinned: row.always_on_top === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listDesktopStickyRecords() {
  return getDb()
    .prepare('SELECT * FROM desktop_stickies ORDER BY created_at ASC, id ASC')
    .all()
    .map(toRecord)
}

export function countDesktopStickyRecords() {
  return getDb().prepare('SELECT COUNT(*) AS total FROM desktop_stickies').get().total
}

export function hasDesktopStickyRecord(id) {
  return Boolean(getDb().prepare('SELECT 1 FROM desktop_stickies WHERE id = ?').get(id))
}

export function insertDesktopStickyRecord(record) {
  const workArea = record.workArea || {}
  getDb()
    .prepare(
      `INSERT INTO desktop_stickies
       (id, note_id, content_snapshot, x, y, width, height, display_id,
        work_area_x, work_area_y, work_area_width, work_area_height,
        font_size, background_color, corner_radius, always_on_top, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.noteId,
      record.content,
      record.bounds.x,
      record.bounds.y,
      record.bounds.width,
      record.bounds.height,
      record.displayId == null ? null : String(record.displayId),
      workArea.x ?? null,
      workArea.y ?? null,
      workArea.width ?? null,
      workArea.height ?? null,
      record.fontSize,
      record.backgroundColor,
      record.cornerRadius,
      record.pinned ? 1 : 0,
      record.createdAt,
      record.updatedAt
    )
  return record
}

export function updateDesktopStickyRecord(id, patch) {
  const assignments = []
  const values = []
  for (const [key, column] of Object.entries(UPDATE_COLUMNS)) {
    if (!Object.hasOwn(patch, key)) continue
    assignments.push(`${column} = ?`)
    values.push(key === 'alwaysOnTop' ? (patch[key] ? 1 : 0) : patch[key])
  }
  if (!assignments.length) return false
  assignments.push('updated_at = ?')
  values.push(Number(patch.updatedAt) || Date.now(), id)
  return (
    getDb()
      .prepare(`UPDATE desktop_stickies SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...values).changes === 1
  )
}

export function deleteDesktopStickyRecord(id) {
  return getDb().prepare('DELETE FROM desktop_stickies WHERE id = ?').run(id).changes === 1
}

export function deleteAllDesktopStickyRecords() {
  return getDb().prepare('DELETE FROM desktop_stickies').run().changes
}
