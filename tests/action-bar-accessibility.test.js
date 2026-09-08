import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ACTION_BAR_PATH = new URL(
  '../src/renderer/src/components/list/ActionBar.vue',
  import.meta.url
)

describe('ActionBar accessibility', () => {
  it('moves focus off a hint before hiding it from assistive technology', () => {
    const source = readFileSync(ACTION_BAR_PATH, 'utf8')
    const openExpanded = source.slice(
      source.indexOf('function openExpanded()'),
      source.indexOf('function closeExpanded(')
    )

    expect(openExpanded).toContain('activeElement === newHintRef.value')
    expect(openExpanded).toContain('newButtonRef.value?.focus?.({ preventScroll: true })')
    expect(openExpanded).toContain('activeElement === searchHintRef.value')
    expect(openExpanded).toContain('searchButtonRef.value?.focus?.({ preventScroll: true })')
    expect(openExpanded.indexOf('newButtonRef.value?.focus')).toBeLessThan(
      openExpanded.indexOf("phase.value = 'opening'")
    )
    expect(source).toContain(':aria-hidden="!isHintInteractive(\'new\')"')
    expect(source).toContain(':aria-hidden="!isHintInteractive(\'search\')"')
  })
})
