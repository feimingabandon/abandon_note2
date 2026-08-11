/** 附件规则由渲染层预检与主进程强制校验共同复用。 */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_NOTE = 50
export const MAX_ATTACHMENT_BATCH_BYTES = 200 * 1024 * 1024

export function getBase64DecodedSize(value) {
  const raw = String(value || '').trim()
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
  if (!base64) return 0
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new Error('图片数据格式无效')
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

export function getAttachmentBatchBytes(images, { trustDeclaredSize = false } = {}) {
  if (!Array.isArray(images)) return 0
  return images.reduce((total, image) => {
    const declaredSize = Number(image?.size)
    const size =
      trustDeclaredSize && Number.isFinite(declaredSize) && declaredSize >= 0
        ? declaredSize
        : getBase64DecodedSize(image?.base64)
    return total + size
  }, 0)
}

export function assertAttachmentBatchWithinLimit(images, options = {}) {
  const batch = Array.isArray(images) ? images : []
  const maxCount = Math.max(0, Number(options.maxCount ?? MAX_ATTACHMENTS_PER_NOTE))
  if (batch.length > maxCount) {
    throw new Error(`本次最多添加 ${Math.max(0, maxCount)} 张图片`)
  }
  const totalBytes = getAttachmentBatchBytes(batch, options)
  if (totalBytes > MAX_ATTACHMENT_BATCH_BYTES) {
    throw new Error('单批新增图片总量不能超过 200MB')
  }
  return totalBytes
}
