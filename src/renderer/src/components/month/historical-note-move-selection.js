// A range-wide selection must include eligible notes on pages not loaded yet.
export function createHistoricalMoveSelection(all = true) {
  return { all, ids: new Set() }
}

export function isHistoricalMoveSelected(selection, note) {
  if (!note?.canMove) return false
  return selection.all ? !selection.ids.has(note.id) : selection.ids.has(note.id)
}

export function toggleHistoricalMoveSelection(selection, note) {
  if (!note?.canMove) return selection
  const ids = new Set(selection.ids)
  if (ids.has(note.id)) ids.delete(note.id)
  else ids.add(note.id)
  return { all: selection.all, ids }
}

export function historicalMoveSelectionCount(selection, movableCount, notes) {
  const eligible = new Set(notes.filter((note) => note.canMove).map((note) => note.id))
  const knownIds = [...selection.ids].filter((id) => eligible.has(id)).length
  return selection.all ? Math.max(0, movableCount - knownIds) : knownIds
}

export function historicalMoveSelectionPayload(selection, notes) {
  const eligible = new Set(notes.filter((note) => note.canMove).map((note) => note.id))
  const ids = [...selection.ids].filter((id) => eligible.has(id))
  return selection.all ? { excludedNoteIds: ids } : { noteIds: ids }
}
