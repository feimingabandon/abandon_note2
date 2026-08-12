<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppModalShell from './AppModalShell.vue'
import BaseButton from './BaseButton.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import TagEditorForm from './TagEditorForm.vue'
import { useMessage } from '../../composables/useMessage.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  createOnOpen: { type: Boolean, default: false }
})
const emit = defineEmits(['update:visible'])
const { showMessage } = useMessage()

const colorPresets = [
  '#007aff',
  '#ff3b30',
  '#34c759',
  '#ff9500',
  '#af52de',
  '#ff2d55',
  '#5856d6',
  '#00c7be',
  '#7b7b7b',
  '#ff9f0a',
  '#30b0c7',
  '#d35400'
]

const tags = ref([])
const query = ref('')
const loading = ref(false)
const saving = ref(false)
const toolbarInputRef = ref(null)
const formOpen = ref(false)
const formMode = ref('create')
const editingTag = ref(null)
const formName = ref('')
const formColor = ref('')
const formColorText = ref('')
const formError = ref('')
const editUsage = ref(null)
const tagToDelete = ref(null)
const deleteUsage = ref(null)
const deleteUsageUnavailable = ref(false)
const showDeleteDialog = ref(false)
let tagsLoadSequence = 0
let usageSequence = 0
let deleteSequence = 0
let formResetTimer = null
let scrollTimer = null
let formTriggerElement = null

const filteredTags = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  const rows = keyword
    ? tags.value.filter((tag) => tag.name.toLocaleLowerCase().includes(keyword))
    : [...tags.value]
  return rows
})
const formColorInvalid = computed(
  () => !!formColorText.value && !/^#[0-9a-f]{6}$/i.test(formColorText.value)
)
const usageText = computed(() => {
  if (formMode.value !== 'edit') return ''
  if (!editUsage.value) return '正在读取使用范围…'
  return `当前用于 ${editUsage.value.noteCount} 条便签和 ${editUsage.value.templateCount} 个循环模板`
})
const deleteMessage = computed(() => {
  const name = tagToDelete.value?.name || ''
  if (deleteUsageUnavailable.value)
    return `确定删除标签「${name}」吗？暂时无法读取关联详情，删除仍会解除全部关联。`
  if (!deleteUsage.value) return `正在读取标签「${name}」的使用情况…`
  if (!deleteUsage.value.noteCount && !deleteUsage.value.templateCount)
    return `当前没有便签或循环模板使用标签「${name}」。删除后无法恢复。`
  return `标签「${name}」正在被 ${deleteUsage.value.noteCount} 条便签和 ${deleteUsage.value.templateCount} 个循环模板使用。删除后会解除全部关联，且无法恢复。`
})

watch(formColor, (value) => {
  formColorText.value = value || ''
})
watch(
  () => props.visible,
  async (visible) => {
    if (visible) {
      await loadTags()
      if (props.createOnOpen) openCreate()
    } else {
      closeForm({ restoreFocus: false })
      showDeleteDialog.value = false
      clearDelete()
    }
  },
  { immediate: true }
)

async function loadTags() {
  const sequence = ++tagsLoadSequence
  loading.value = true
  try {
    const result = await window.api.listTags()
    if (sequence === tagsLoadSequence) tags.value = result
  } catch (error) {
    console.error('[TagManagerDialog] 加载标签失败:', error)
  } finally {
    if (sequence === tagsLoadSequence) loading.value = false
  }
}

function resetForm() {
  formMode.value = 'create'
  editingTag.value = null
  formName.value = ''
  formColor.value = ''
  formColorText.value = ''
  formError.value = ''
  editUsage.value = null
  formTriggerElement = null
}

function openCreate(event) {
  if (formOpen.value && formMode.value === 'create') {
    closeForm()
    return
  }
  clearTimeout(formResetTimer)
  resetForm()
  formTriggerElement = event?.currentTarget || null
  formColor.value = colorPresets[Math.floor(Math.random() * colorPresets.length)]
  formOpen.value = true
}

async function openEdit(tag, event) {
  if (formOpen.value && formMode.value === 'edit' && editingTag.value?.id === tag.id) {
    closeForm()
    return
  }
  clearTimeout(formResetTimer)
  clearTimeout(scrollTimer)
  formTriggerElement = event?.currentTarget || null
  formMode.value = 'edit'
  editingTag.value = tag
  formName.value = tag.name
  formColor.value = tag.color || ''
  formColorText.value = formColor.value
  formError.value = ''
  editUsage.value = null
  formOpen.value = true
  const itemElement = event?.currentTarget?.closest('.tm-item')
  if (itemElement) {
    scrollTimer = setTimeout(() => {
      if (formOpen.value && editingTag.value?.id === tag.id) {
        itemElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }, 320)
  }
  const sequence = ++usageSequence
  try {
    const usage = await window.api.getTagUsage(tag.id)
    if (sequence === usageSequence && editingTag.value?.id === tag.id) editUsage.value = usage
  } catch (error) {
    console.error('[TagManagerDialog] 读取标签使用情况失败:', error)
  }
}

function closeForm({ restoreFocus = true } = {}) {
  usageSequence++
  clearTimeout(scrollTimer)
  formOpen.value = false
  const focusTarget = restoreFocus ? formTriggerElement : null
  if (focusTarget) {
    nextTick(() => {
      if (focusTarget.isConnected && typeof focusTarget.focus === 'function') focusTarget.focus()
    })
  }
  clearTimeout(formResetTimer)
  formResetTimer = setTimeout(() => {
    if (!formOpen.value) resetForm()
  }, 300)
}

onBeforeUnmount(() => {
  tagsLoadSequence++
  usageSequence++
  deleteSequence++
  clearTimeout(formResetTimer)
  clearTimeout(scrollTimer)
})

function onColorTextInput(event) {
  let value = String(event ?? '').trim()
  if (value && !value.startsWith('#')) value = `#${value}`
  formColorText.value = value
  if (!value) formColor.value = ''
  else if (/^#[0-9a-f]{6}$/i.test(value)) formColor.value = value.toLowerCase()
}

async function saveTag() {
  const name = formName.value.trim()
  if (!name || saving.value) return
  if (formColorInvalid.value) {
    formError.value = '请输入 6 位十六进制颜色，例如 #007aff'
    return
  }
  const operation = {
    mode: formMode.value,
    tagId: editingTag.value?.id ?? null,
    name,
    color: formColor.value || null
  }
  saving.value = true
  formError.value = ''
  try {
    if (operation.mode === 'edit') {
      await window.api.updateTag(operation.tagId, {
        name: operation.name,
        color: operation.color
      })
    } else {
      const created = await window.api.createTag(operation.name, operation.color)
      if (!created) throw new Error('标签名称已存在')
    }
    if (isCurrentFormOperation(operation)) {
      saving.value = false
      closeForm()
    }
    await loadTags()
  } catch (error) {
    if (isCurrentFormOperation(operation)) {
      formError.value = error.message || '保存失败，请重试'
    } else {
      showMessage('error', error.message || '保存标签失败')
    }
  } finally {
    saving.value = false
  }
}

function isCurrentFormOperation(operation) {
  if (!formOpen.value || formMode.value !== operation.mode) return false
  return operation.mode !== 'edit' || editingTag.value?.id === operation.tagId
}

async function requestDelete(tag) {
  tagToDelete.value = tag
  deleteUsage.value = null
  deleteUsageUnavailable.value = false
  const sequence = ++deleteSequence
  try {
    const usage = await window.api.getTagUsage(tag.id)
    if (sequence !== deleteSequence || tagToDelete.value?.id !== tag.id) return
    deleteUsage.value = usage
  } catch {
    if (sequence !== deleteSequence) return
    deleteUsageUnavailable.value = true
  }
  if (sequence === deleteSequence) showDeleteDialog.value = true
}

function clearDelete() {
  deleteSequence++
  tagToDelete.value = null
  deleteUsage.value = null
  deleteUsageUnavailable.value = false
}

async function confirmDelete() {
  if (!tagToDelete.value) return
  try {
    await window.api.deleteTag(tagToDelete.value.id)
    if (editingTag.value?.id === tagToDelete.value.id) closeForm()
    await loadTags()
    await nextTick()
    toolbarInputRef.value?.focus()
  } catch (error) {
    console.error('[TagManagerDialog] 删除标签失败:', error)
  } finally {
    clearDelete()
  }
}
</script>

<template>
  <AppModalShell
    :visible="visible"
    title="标签管理"
    :subtitle="`共 ${tags.length} 个标签`"
    width="min(500rem, calc(100vw - 32rem))"
    height="min(650rem, calc(100vh - 32rem))"
    :close-disabled="saving"
    flush
    @update:visible="emit('update:visible', $event)"
  >
    <div class="tm-root">
      <div class="tm-toolbar">
        <input
          ref="toolbarInputRef"
          v-model="query"
          type="search"
          placeholder="搜索标签…"
          aria-label="搜索标签"
          :disabled="saving"
        />
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="saving"
          :aria-expanded="formOpen && formMode === 'create'"
          @click="openCreate"
        >
          {{ formOpen && formMode === 'create' ? '收起新建' : '新建标签' }}
        </BaseButton>
      </div>

      <Transition name="tm-form">
        <div v-if="formOpen && formMode === 'create'" class="tm-form-motion">
          <div class="tm-form-clip">
            <TagEditorForm
              mode="create"
              :name="formName"
              :color="formColor"
              :color-text="formColorText"
              :error="formError"
              :saving="saving"
              :color-invalid="formColorInvalid"
              :color-presets="colorPresets"
              @update:name="formName = $event"
              @update:color="formColor = $event"
              @update:color-text="onColorTextInput"
              @cancel="closeForm"
              @save="saveTag"
            />
          </div>
        </div>
      </Transition>

      <div class="tm-list scroll-y">
        <p v-if="loading" class="tm-empty">正在加载…</p>
        <p v-else-if="filteredTags.length === 0" class="tm-empty">
          {{ query.trim() ? '没有匹配的标签' : '暂无标签' }}
        </p>
        <div
          v-for="tag in filteredTags"
          :key="tag.id"
          class="tm-item"
          :class="{
            'is-editing': formMode === 'edit' && editingTag?.id === tag.id
          }"
        >
          <div class="tm-row">
            <span
              class="tm-dot"
              :style="{
                backgroundColor:
                  tag.color || 'color-mix(in srgb, var(--text-color) 45%, transparent)'
              }"
            />
            <span class="tm-name" :title="tag.name">{{ tag.name }}</span>
            <button
              type="button"
              class="tm-edit"
              :disabled="saving"
              :aria-expanded="formOpen && formMode === 'edit' && editingTag?.id === tag.id"
              @click="openEdit(tag, $event)"
            >
              {{
                formOpen && formMode === 'edit' && editingTag?.id === tag.id ? '收起修改' : '修改'
              }}
            </button>
            <button type="button" class="tm-delete" :disabled="saving" @click="requestDelete(tag)">
              删除
            </button>
          </div>
          <Transition name="tm-form">
            <div
              v-if="formOpen && formMode === 'edit' && editingTag?.id === tag.id"
              class="tm-form-motion"
            >
              <div class="tm-form-clip">
                <TagEditorForm
                  mode="edit"
                  :name="formName"
                  :color="formColor"
                  :color-text="formColorText"
                  :error="formError"
                  :usage-text="usageText"
                  :saving="saving"
                  :color-invalid="formColorInvalid"
                  :color-presets="colorPresets"
                  @update:name="formName = $event"
                  @update:color="formColor = $event"
                  @update:color-text="onColorTextInput"
                  @cancel="closeForm"
                  @save="saveTag"
                />
              </div>
            </div>
          </Transition>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-model:visible="showDeleteDialog"
      title="删除标签"
      :message="deleteMessage"
      confirm-text="删除"
      variant="danger"
      @confirm="confirmDelete"
      @cancel="clearDelete"
    />
  </AppModalShell>
</template>

<style scoped>
.tm-root {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  color: var(--text-color);
}
.tm-toolbar {
  display: flex;
  gap: 10rem;
  padding: 14rem 16rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.tm-toolbar input {
  min-width: 0;
  border: 1px solid var(--ui-border-control);
  border-radius: 7rem;
  outline: 0;
  background: var(--ui-surface-control);
  color: var(--text-color);
  font: inherit;
}
.tm-toolbar input {
  flex: 1;
  padding: 7rem 10rem;
}
.tm-toolbar input:focus {
  border-color: #007aff;
}
.tm-edit,
.tm-delete {
  border: 0;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  cursor: pointer;
}
.tm-edit:hover:not(:disabled),
.tm-delete:hover:not(:disabled) {
  background: var(--ui-fill-hover);
}
.tm-edit:active:not(:disabled),
.tm-delete:active:not(:disabled) {
  transform: scale(0.98);
}
.tm-edit:disabled,
.tm-delete:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.tm-form-motion {
  display: grid;
  grid-template-rows: 1fr;
  flex: 0 0 auto;
}
.tm-form-clip {
  min-height: 0;
  overflow: hidden;
}
.tm-form-enter-active,
.tm-form-leave-active {
  overflow: hidden;
  transition:
    grid-template-rows 300ms cubic-bezier(0.32, 0.72, 0, 1),
    opacity 220ms ease;
}
.tm-form-enter-active :deep(.tm-editor-form),
.tm-form-leave-active :deep(.tm-editor-form) {
  transition: transform 300ms cubic-bezier(0.32, 0.72, 0, 1);
}
.tm-form-enter-from,
.tm-form-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
.tm-form-enter-from :deep(.tm-editor-form),
.tm-form-leave-to :deep(.tm-editor-form) {
  transform: translateY(-7rem);
}
.tm-list {
  min-height: 0;
  flex: 1;
  padding: 6rem 8rem 10rem;
}
.tm-row {
  display: flex;
  min-height: 40rem;
  align-items: center;
  gap: 8rem;
  padding: 4rem 7rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.tm-item:last-child .tm-row {
  border-bottom: 0;
}
.tm-item.is-editing .tm-row {
  border-bottom: 0;
}
.tm-dot {
  width: 8rem;
  height: 8rem;
  flex: 0 0 auto;
  border-radius: 50%;
}
.tm-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tm-edit,
.tm-delete {
  padding: 5rem 7rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.tm-delete {
  color: #ff3b30;
}
.tm-empty {
  margin: 40rem 0;
  color: var(--text-color-secondary);
  text-align: center;
}
</style>
