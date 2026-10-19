import { cleanupStagedImage, deleteImageFile, restoreStagedImageDeletion } from './db-images.js'

/** Keep each published file's recovery manifest until its deletion is confirmed.
 * Every branch settles before the command rethrows its original SQL/staging error.
 */
export async function compensateFailedNoteAssets({
  writtenImages = [],
  stagedImages = [],
  stagedDeletions = []
}) {
  const deleted = await Promise.allSettled(
    writtenImages.map(({ relativePath }) =>
      Promise.resolve().then(() => deleteImageFile(relativePath))
    )
  )
  const preserved = new Set()
  deleted.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled' && outcome.value === true) return
    const image = writtenImages[index]
    preserved.add(image.staged)
    console.warn('[images] 附件回滚删除未完成，保留恢复凭据:', {
      relativePath: image.relativePath,
      operationDirectory: image.staged?.operationDirectory,
      reason: outcome.status === 'rejected' ? outcome.reason?.message : '删除未成功'
    })
  })
  const cleanup = await Promise.allSettled(
    stagedImages
      .filter((staged) => !preserved.has(staged))
      .map((staged) => Promise.resolve().then(() => cleanupStagedImage(staged)))
  )
  const restored = await Promise.allSettled(
    [...stagedDeletions]
      .reverse()
      .map((staged) => Promise.resolve().then(() => restoreStagedImageDeletion(staged)))
  )
  for (const outcome of [...cleanup, ...restored]) {
    if (outcome.status === 'rejected')
      console.warn('[images] 附件补偿未完成，保留现场待恢复:', outcome.reason)
  }
}
