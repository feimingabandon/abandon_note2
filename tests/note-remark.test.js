import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createSettingsOperationAdmission } from '../src/main/settings/settings-operation-admission.js'
import { parseForESLint } from 'vue-eslint-parser'
import { RENDERER_WRITABLE_SETTING_IDS } from '../src/shared/settings-schema.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

function nodes(source) {
  const result = []
  function visit(node) {
    if (!node || typeof node.type !== 'string') return
    result.push(node)
    for (const [key, value] of Object.entries(node)) {
      if (['parent', 'tokens', 'comments'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseForESLint(source, { ecmaVersion: 'latest', sourceType: 'module' }).ast)
  return result
}

const callName = (node) => node.callee?.name || node.callee?.property?.name
const property = (node, name) =>
  node?.properties?.find((entry) => (entry.key?.name || entry.key?.value) === name)?.value

function rendererSettingIds() {
  const ids = new Set()
  const root = new URL('../src/renderer/src/', import.meta.url)
  for (const file of readdirSync(root, { recursive: true })) {
    if (!/\.(js|vue)$/.test(file)) continue
    const source = readFileSync(new URL(file.replaceAll('\\', '/'), root), 'utf8')
    if (!/setSettingValue|debouncedSave|persistSetting|useStickySettingsForm/.test(source)) continue
    const astNodes = nodes(source)
    const stickySave = astNodes
      .filter(
        (node) => node.type === 'CallExpression' && callName(node) === 'useStickySettingsForm'
      )
      .map((node) => property(node.arguments[0], 'save'))
    for (const node of astNodes.filter((entry) => entry.type === 'CallExpression')) {
      const name = callName(node)
      if (!['setSettingValue', 'debouncedSave', 'persistSetting'].includes(name)) continue
      const id = name === 'persistSetting' ? property(node.arguments[0], 'id') : node.arguments[0]
      if (id?.type === 'Literal' && typeof id.value === 'string') {
        ids.add(id.value)
        continue
      }
      // The write queue passes each collected ID through unchanged; the sticky form is its
      // only dynamic caller and has a separately checked literal-ID save contract below.
      if (
        file.endsWith('useSettingsWriteQueue.js') &&
        name === 'setSettingValue' &&
        id?.object?.name === 'entry' &&
        id?.property?.name === 'id'
      )
        continue
      expect(
        stickySave.some((save) => save?.body === node),
        `${file}: untracked setting write`
      ).toBe(true)
      expect(id.name).toBe(stickySave[0].params[0].name)
      const stickySource = read('../src/renderer/src/composables/useStickySettingsForm.js')
      for (const save of nodes(stickySource).filter(
        (entry) => entry.type === 'CallExpression' && callName(entry) === 'save'
      )) {
        expect(save.arguments[0].type).toBe('Literal')
        ids.add(save.arguments[0].value)
      }
    }
  }
  return ids
}

function settingIpcContract() {
  const main = read('../src/main/index.js')
  const astNodes = nodes(main)
  const allowlist = astNodes.find(
    (node) => node.type === 'VariableDeclarator' && node.id.name === 'RENDERER_WRITABLE_SETTING_IDS'
  )
  const schemaImport = astNodes.find(
    (node) =>
      node.type === 'ImportDeclaration' && node.source.value === '../shared/settings-schema.js'
  )
  const importedIds = schemaImport.specifiers.find(
    (specifier) => specifier.imported?.name === 'RENDERER_WRITABLE_SETTING_IDS'
  )
  expect(importedIds, 'main must use the shared renderer write policy').toBeDefined()
  expect(allowlist.init.callee.name).toBe('Set')
  expect(allowlist.init.arguments[0]).toMatchObject({
    type: 'Identifier',
    name: importedIds.local.name
  })
  const ids = new Set(RENDERER_WRITABLE_SETTING_IDS)
  const handler = astNodes.find(
    (node) =>
      node.type === 'CallExpression' &&
      node.callee.object?.name === 'mainWindowIpc' &&
      callName(node) === 'handle' &&
      node.arguments[0].value === 'set-setting-value'
  ).arguments[1]
  const committed = { source: { token: 'current', scope: 'main' }, revision: 3, values: {} }
  const persist = vi.fn(() => committed)
  const source = { assert: vi.fn() }
  const invoke = new Function(
    'RENDERER_WRITABLE_SETTING_IDS',
    'persistSettingValue',
    'settingsWriteSource',
    'settingsOperations',
    `return (${main.slice(...handler.range)})`
  )(ids, persist, source, createSettingsOperationAdmission())
  return { ids, persist, invoke, source, committed }
}

describe('便签备注', () => {
  it('rejects an expired page before the actual setting handler persists a value', async () => {
    const { source, persist, invoke } = settingIpcContract()
    source.assert.mockImplementation(() => {
      throw new Error('source expired')
    })
    await expect(invoke(null, 'css.noteRemarkFontSize', 18, { token: 'old' })).rejects.toThrow(
      'expired'
    )
    expect(persist).not.toHaveBeenCalled()
  })
  it('passes the optional remark from both creation forms and the full editor', () => {
    for (const path of [
      '../src/renderer/src/components/list/NewNotePanel.vue',
      '../src/renderer/src/components/month/MonthNoteCreator.vue',
      '../src/renderer/src/components/note/NoteEditor.vue'
    ]) {
      const source = read(path)
      const ast = nodes(source)
      const options = path.endsWith('NoteEditor.vue')
        ? property(
            ast.find(
              (node) =>
                node.type === 'CallExpression' &&
                callName(node) === 'commitNote' &&
                node.arguments[0]?.value === 'save' &&
                property(node.arguments[1], 'fields')
            ).arguments[1],
            'fields'
          )
        : ast.find((node) => node.type === 'VariableDeclarator' && node.id.name === 'options').init
      expect(source).toMatch(/<NoteRemarkField\b[^>]*v-model="remark"/)
      const remark = property(options, 'remark')
      expect(
        ast.some(
          (node) =>
            node.type === 'MemberExpression' &&
            node.object?.name === 'remark' &&
            node.property?.name === 'value' &&
            node.range[0] >= remark?.range[0] &&
            node.range[1] <= remark?.range[1]
        ),
        path + ': the submitted remark must use the current field value'
      ).toBe(true)
    }
  })

  it('persists the remark in schema, note updates and list DTOs', () => {
    const schema = read('../src/main/db/db-schema.js')
    const notes = read('../src/main/db/db-notes.js')

    expect(Number(schema.match(/DATABASE_SCHEMA_VERSION = (\d+)/)[1])).toBeGreaterThanOrEqual(16)
    expect(schema).toContain("ALTER TABLE notes ADD COLUMN remark TEXT NOT NULL DEFAULT ''")
    expect(schema).toContain("remark              TEXT    NOT NULL DEFAULT ''")
    expect(notes).toContain(
      "fields.remark === undefined ? old.remark : String(fields.remark ?? '')"
    )
    expect(notes).toContain('content = ?, content_color_ranges = ?, remark = ?, is_pinned = ?')
    expect(notes).toContain('remark: note.remark')
  })

  it('protects both quick-edit fields from concurrent overwrites', () => {
    const preload = read('../src/preload/index.js')
    const ipc = read('../src/main/ipc/register-business-ipc.js')

    expect(preload).toContain('updateNote: (id, fields, expectedContent, expectedRemark)')
    expect(ipc).toContain('expectedContent !== undefined && current.content !== expectedContent')
    expect(ipc).toContain('expectedRemark !== undefined && current.remark !== expectedRemark')
  })

  it('shows the remark below the body and opens one shared two-field editor', () => {
    const card = read('../src/renderer/src/components/note/NoteCard.vue')
    const editor = read('../src/renderer/src/components/note/QuickNoteContentEditor.vue')
    const tokens = read('../src/renderer/src/assets/tokens.css')
    const contentIndex = card.indexOf('ref="contentTextRef"')
    const remarkIndex = card.indexOf('class="nl-card-remark-text"')
    const metadataIndex = card.indexOf('class="nl-card-meta"')
    const remarkStyle = card.match(/\.nl-card-remark-text \{([\s\S]*?)\}/)?.[1]

    expect(card).toContain('class="nl-card-remark-toggle"')
    expect(card).toContain('@click.stop="openQuickEditor($event, true)"')
    expect(card).toContain('font-size: var(--note-remark-font-size)')
    expect(remarkStyle).toContain('color: var(--text-color-secondary)')
    expect(tokens).toContain('--note-remark-font-size: calc(var(--font-size-base) - 1rem)')
    expect(card).not.toContain('class="nl-card-remark"')
    expect(contentIndex).toBeGreaterThan(-1)
    expect(remarkIndex).toBeGreaterThan(contentIndex)
    expect(metadataIndex).toBeGreaterThan(remarkIndex)
    expect(remarkStyle).toContain('max-height: none')
    expect(remarkStyle).toContain('overflow: visible')
    expect(remarkStyle).toContain('overflow-wrap: anywhere')
    expect(remarkStyle).toContain('text-overflow: clip')
    expect(remarkStyle).toContain('white-space: pre-wrap')
    expect(remarkStyle).not.toContain('line-clamp')
    expect(editor).toContain('v-model="contentDraft"')
    expect(editor).toContain('v-model="remarkDraft"')
    expect(editor).toContain('{ content, remark }')
  })

  it('uses an independently persisted remark font size while retaining the secondary color', () => {
    const schema = read('../src/shared/settings-schema.js')
    const panel = read('../src/renderer/src/components/system/SettingsPanel.vue')
    const applySnapshot = read('../src/renderer/src/utils/applySettingsSnapshot.js')

    expect(schema).toContain("id: 'css.noteRemarkFontSize'")
    expect(schema).toContain("key: 'note_remark_font_size'")
    expect(panel).toContain('v-model="noteRemarkFontSize"')
    expect(panel).toContain("debouncedSave('css.noteRemarkFontSize', v)")
    expect(applySnapshot).toContain(
      "root.style.setProperty('--note-remark-font-size', `${css.noteRemarkFontSize}rem`)"
    )
  })

  it('authorizes every setting the renderer sends through the generic write IPC', () => {
    const { ids } = settingIpcContract()
    const rendererIds = rendererSettingIds()
    expect(rendererIds).toContain('css.noteRemarkFontSize')
    expect(rendererIds).toContain('sticky.fontSize')
    expect(rendererIds).toContain('almanac.enabled')
    expect([...rendererIds].filter((id) => !ids.has(id))).toEqual([])
  })

  it('allows both almanac switch values through the guarded setting handler', async () => {
    const { persist, invoke, committed } = settingIpcContract()
    await expect(invoke(null, 'almanac.enabled', false)).resolves.toBe(committed)
    await expect(invoke(null, 'almanac.enabled', true)).resolves.toBe(committed)
    expect(persist.mock.calls).toEqual([
      ['almanac.enabled', false],
      ['almanac.enabled', true]
    ])
    await expect(invoke(null, 'almanac.unknown', true)).rejects.toThrow(
      'renderer 无权直接写入设置项'
    )
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('persists remark font size through the actual handler while retaining dedicated IPC guards', async () => {
    const { ids, persist, invoke, committed } = settingIpcContract()
    for (const id of ['blur.enabled', 'dock.enabledEdges', 'shortcuts.viewVisibility']) {
      expect(ids.has(id)).toBe(false)
      await expect(invoke(null, id, true)).rejects.toThrow('renderer 无权直接写入设置项')
    }
    expect(persist).not.toHaveBeenCalled()
    await expect(invoke(null, 'css.noteRemarkFontSize', 14)).resolves.toBe(committed)
    expect(persist).toHaveBeenCalledExactlyOnceWith('css.noteRemarkFontSize', 14)
  })
})
