import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('纯图片便签', () => {
  it('allows creation and editing when the final draft still contains an image', () => {
    const listCreator = read('../src/renderer/src/components/list/NewNotePanel.vue')
    const calendarCreator = read('../src/renderer/src/components/month/MonthNoteCreator.vue')
    const editor = read('../src/renderer/src/components/note/NoteEditor.vue')
    const ipc = read('../src/main/ipc/register-business-ipc.js')

    expect(listCreator).toContain('Boolean(content.value.trim()) || draftImageCount.value > 0')
    expect(listCreator).toContain(
      "const submitEmpty = computed(() => submitState.value === 'idle' && !canCreate.value)"
    )
    expect(calendarCreator).toContain('Boolean(content.value.trim()) || draftImageCount.value > 0')
    expect(editor).toContain('Boolean(content.value.trim()) || draftImageCount.value > 0')
    expect(ipc).toContain('allowEmptyContent: stagedImages.length > 0')
    expect(ipc).toContain(
      'original.attachments.length - deletedImageIds.length + addedImages.length'
    )
  })

  it('shows a stable-height carousel in the body position and does not repeat the drawer', () => {
    const card = read('../src/renderer/src/components/list/NoteCard.vue')
    const picker = read('../src/renderer/src/components/note/ImagePicker.vue')
    const preload = read('../src/preload/index.js')
    const ipc = read('../src/main/ipc/register-business-ipc.js')

    expect(card).toContain('const isImageOnly = computed(')
    expect(card).toContain('class="nl-card-primary-images"')
    expect(card).toContain('carousel')
    expect(card).toContain(':refresh-key="note.updated_at"')
    expect(card).toContain(':readonly-max-size="260"')
    expect(card).toContain('v-if="attachmentCount && !isImageOnly"')
    expect(card).toContain(':collapsed-height="160"')
    expect(card).toContain(':expanded="imageExpanded"')
    expect(card).toContain('@overflow-change="imageOverflows = $event"')
    expect(card).toContain('@click.stop="togglePrimaryContent"')
    expect(picker).toContain("carouselDirection.value === 'previous'")
    expect(picker).toContain('aria-label="上一张卡片图片"')
    expect(picker).toContain('aria-label="下一张卡片图片"')
    expect(picker).toContain('const carouselViewportStyle = computed(')
    expect(picker).toContain('v-if="images.length > 1"')
    expect(picker).toContain('Math.min(width, Math.max(0, availableWidth))')
    expect(picker).toContain('border-radius: 8rem')
    expect(picker).toContain('.ip-carousel:hover .ip-carousel__nav')
    expect(picker).toContain('pointer-events: none')
    expect(picker).not.toContain('.ip-carousel__image:hover')
    expect(picker).toContain('window.api.getImageDimensions(rec.file_path)')
    expect(preload).toContain("ipcRenderer.invoke('images:get-dimensions', { relativePath })")
    expect(ipc).toContain("ipcMain.handle('images:get-dimensions'")
  })

  it('opens image preview from month and week bars with previous and next navigation', () => {
    const eventBar = read('../src/renderer/src/components/month/MonthEventBar.vue')
    const grid = read('../src/renderer/src/components/month/MonthCalendarGrid.vue')
    const preview = read('../src/renderer/src/components/note/ImagePreview.vue')

    expect(eventBar).toContain("isImageOnly.value ? '查看图片' : ''")
    expect(eventBar).toContain("emit('preview-images', props.note)")
    expect(grid).toContain('@preview-images="openImagePreview"')
    expect(grid).toContain('class="month-day-preview__image-link"')
    expect(grid).toContain('<NoteImagePreview')
    expect(preview).toContain('aria-label="上一张图片"')
    expect(preview).toContain('aria-label="下一张图片"')
    expect(preview).toContain("e.key === 'ArrowLeft'")
    expect(preview).toContain("e.key === 'ArrowRight'")
    expect(preview).toContain("navigationDirection.value === 'previous'")
    expect(preview).toContain('<Transition :name="imageTransitionName">')
    expect(preview).toContain('.ipv-image-next-enter-from')
    expect(preview).toContain('.ipv-image-previous-enter-from')
    expect(preview).toContain('} else {\n      // 预览可能在拖拽途中')
    expect(preview).toContain('onMouseUp()')
  })
})
