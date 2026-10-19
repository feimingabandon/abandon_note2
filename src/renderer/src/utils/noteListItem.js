export function mergeNoteListItem(current, updated) {
  return {
    ...current,
    ...updated,
    tags: Array.isArray(updated.tags) ? updated.tags : current.tags,
    attachment_count: Number.isFinite(Number(updated.attachment_count))
      ? Number(updated.attachment_count)
      : current.attachment_count,
    has_text: typeof updated.has_text === 'boolean' ? updated.has_text : current.has_text,
    has_image: typeof updated.has_image === 'boolean' ? updated.has_image : current.has_image
  }
}
