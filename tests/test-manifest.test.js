import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import manifest from '../scripts/test-manifest.cjs'

const normalize = (value) => value.replaceAll('\\', '/')

describe('test manifest', () => {
  it('classifies every mjs integration test or helper exactly once, including subdirectories', () => {
    const discovered = readdirSync(new URL('.', import.meta.url), { recursive: true })
      .map(normalize)
      .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
      .map((name) => `tests/${name}`)
      .sort()
    const registered = manifest.registeredMjsFiles.map(normalize).sort()

    expect(new Set(registered).size).toBe(registered.length)
    expect(registered).toEqual(discovered)
  })

  it('keeps runnable Electron groups separate from helpers and manual acceptance work', () => {
    const automated = new Set([
      ...manifest.databaseTests,
      ...manifest.storageTests,
      ...manifest.windowFrameTests,
      ...manifest.electronFeatureTests
    ])

    for (const path of [
      ...manifest.helperFiles,
      ...manifest.acceptanceTests,
      ...manifest.benchmarkTests
    ]) {
      expect(automated.has(path)).toBe(false)
    }
  })
})
