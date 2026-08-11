import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../src/renderer/', import.meta.url))
const TOKENS_PATH = new URL('../src/renderer/src/assets/tokens.css', import.meta.url)
const PRESENCE_PATH = new URL(
  '../src/renderer/src/composables/useNotePresenceMotion.js',
  import.meta.url
)

const LOCAL_LAYERS = [
  '--z-local-base',
  '--z-local-content',
  '--z-local-raised',
  '--z-local-overlay',
  '--z-local-top'
]

const GLOBAL_LAYERS = [
  '--z-global-presence',
  '--z-global-panel',
  '--z-global-workspace',
  '--z-global-editor',
  '--z-global-modal',
  '--z-global-popover',
  '--z-global-preview',
  '--z-global-confirm',
  '--z-global-toast',
  '--z-global-critical'
]

function readLayerValues(source, names) {
  return names.map((name) => {
    const match = source.match(new RegExp(`${name}:\\s*(\\d+);`))
    expect(match, `缺少层级令牌 ${name}`).not.toBeNull()
    return Number(match[1])
  })
}

function collectRendererSources(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collectRendererSources(path, files)
    else if (['.css', '.js', '.vue'].includes(extname(entry.name))) files.push(path)
  }
  return files
}

describe('UI 层级令牌', () => {
  it('局部与全局层级均按连续顺序定义', () => {
    const tokens = readFileSync(TOKENS_PATH, 'utf8')

    expect(readLayerValues(tokens, LOCAL_LAYERS)).toEqual([0, 1, 2, 3, 4])
    expect(readLayerValues(tokens, GLOBAL_LAYERS)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('退场便签副本固定低于标签选择面板', () => {
    const tokens = readFileSync(TOKENS_PATH, 'utf8')
    const [presence] = readLayerValues(tokens, ['--z-global-presence'])
    const [popover] = readLayerValues(tokens, ['--z-global-popover'])
    const presenceMotion = readFileSync(PRESENCE_PATH, 'utf8')

    expect(presence).toBeLessThan(popover)
    expect(presenceMotion).toContain("zIndex: 'var(--z-global-presence)'")
    expect(presenceMotion).toContain("setAttribute('data-presence-clone', '')")
  })

  it('渲染端不再新增裸数字层级', () => {
    const violations = []
    const rules = [
      { name: 'JS zIndex', pattern: /(?<![\w])zIndex\s*:\s*['"`]?\s*-?\d/g },
      { name: 'style.zIndex', pattern: /\.style\.zIndex\s*=\s*['"`]?\s*-?\d/g },
      { name: 'Vue z-index prop', pattern: /:z-index\s*=\s*['"]\s*-?\d/g }
    ]

    for (const path of collectRendererSources(ROOT)) {
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/(?<![-\w])z-index\s*:\s*([^;\n}]+)/g)) {
        if (match[1].trim().startsWith('var(--z-')) continue
        const line = source.slice(0, match.index).split('\n').length
        violations.push(`${relative(ROOT, path)}:${line} CSS z-index`)
      }
      for (const rule of rules) {
        for (const match of source.matchAll(rule.pattern)) {
          const line = source.slice(0, match.index).split('\n').length
          violations.push(`${relative(ROOT, path)}:${line} ${rule.name}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})
