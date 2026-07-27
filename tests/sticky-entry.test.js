import { readFileSync, existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = resolve(projectRoot, 'src/renderer')
const stickyHtmlPath = resolve(rendererRoot, 'sticky.html')

describe('sticky renderer entry', () => {
  it('keeps development assets inside the electron-vite renderer root', () => {
    const html = readFileSync(stickyHtmlPath, 'utf8')
    const localAssets = [...html.matchAll(/(?:href|src)="(\.\/sticky\/[^"]+)"/g)].map(
      (match) => match[1]
    )

    expect(localAssets).toEqual(['./sticky/sticky.css', './sticky/sticky.js'])
    for (const relativePath of localAssets) {
      const assetPath = resolve(rendererRoot, relativePath)
      expect(relative(rendererRoot, assetPath).startsWith('..')).toBe(false)
      expect(existsSync(assetPath)).toBe(true)
    }
  })

  it('includes the persisted corner radius in the sticky renderer contract', () => {
    const css = readFileSync(resolve(rendererRoot, 'sticky/sticky.css'), 'utf8')
    const script = readFileSync(resolve(rendererRoot, 'sticky/sticky.js'), 'utf8')

    expect(css).toContain('--sticky-corner-radius')
    expect(css).toContain('border-radius: var(--sticky-corner-radius)')
    expect(script).toContain("'--sticky-corner-radius'")
  })

  it('keeps primary actions left, the drag region centered, and close on the right', () => {
    const html = readFileSync(stickyHtmlPath, 'utf8')
    const fontAction = html.indexOf('data-action="font-down"')
    const dragRegion = html.indexOf('class="sticky-drag-area"')
    const closeAction = html.indexOf('data-action="close"')

    expect(fontAction).toBeGreaterThan(-1)
    expect(fontAction).toBeLessThan(dragRegion)
    expect(dragRegion).toBeLessThan(closeAction)
  })

  it('starts content below the toolbar without a top gap and preserves bottom space', () => {
    const html = readFileSync(stickyHtmlPath, 'utf8')
    const css = readFileSync(resolve(rendererRoot, 'sticky/sticky.css'), 'utf8')

    expect(html).toContain('class="sticky-content-scroll"')
    expect(css).toContain('padding: 0 16px var(--sticky-content-bottom-space)')
    expect(css).toContain('.sticky-content-scroll')
    expect(css).toContain('height: 100%')
  })
})
