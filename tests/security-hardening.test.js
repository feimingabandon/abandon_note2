import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

describe('渲染入口 CSP', () => {
  it.each(['index.html', 'month.html', 'week.html', 'sticky.html', 'reminder.html'])(
    '%s 禁止插件、base 重写和表单外传',
    (entry) => {
      const html = read(`src/renderer/${entry}`)
      expect(html).toContain("object-src 'none'")
      expect(html).toContain("base-uri 'none'")
      expect(html).toContain("form-action 'none'")
    }
  )
})

describe('Windows 专用构建边界', () => {
  it('默认与显式打包入口都只生成 Windows x64 资产', () => {
    const config = read('electron-builder.win.yml')
    const pkg = JSON.parse(read('package.json'))
    expect(read('electron-builder.yml')).toContain("extends: 'file:./electron-builder.win.yml'")
    expect(config).toContain('target: nsis')
    expect(config).toContain('- x64')
    expect(config).not.toMatch(/\b(?:mac|linux|arm64|ia32):/)
    expect(pkg.scripts['build:win']).toContain('--win nsis --x64 --publish never')
    expect(Object.keys(pkg.scripts).some((name) => name.startsWith('build:mac'))).toBe(false)
  })

  it('删除 Mac 专用配置和资源，图标生成器继续保留 PNG 与 ICO 输出', () => {
    for (const file of [
      'electron-builder.mac.yml',
      'build/entitlements.mac.plist',
      'build/icon.icns'
    ])
      expect(existsSync(resolve(root, file)), file).toBe(false)
    const generator = read('scripts/generate-app-icons.py')
    expect(generator).toContain('BUILD_DIR / "icon.png"')
    expect(generator).toContain('RUNTIME_DIR / "icon.png"')
    expect(generator).toContain('format="ICO"')
    expect(generator).not.toContain('icon.icns')
    expect(generator).not.toContain('format="ICNS"')
  })

  it('当前正式发布工作流只生成 Windows 资产', () => {
    const workflow = read('.github/workflows/release.yml')
    expect(workflow).toContain('--config electron-builder.win.yml --win nsis --x64')
    expect(workflow).not.toContain('  macos:')
    expect(workflow).not.toContain('APPLE_API_KEY')
    expect(workflow).not.toContain('MAC_CSC_LINK')
    expect(workflow).toContain('runs-on: ubuntu-latest')
  })
})

describe('应用与安装器身份', () => {
  it('统一使用 com.abandon.note，并保留旧版 NSIS 升级身份', () => {
    expect(read('src/main/index.js')).toContain("const APP_ID = 'com.abandon.note'")
    expect(read('electron-builder.base.yml')).toContain('appId: com.abandon.note')
    expect(read('electron-builder.win.yml')).toContain('guid: 41249b74-bbe0-5d8d-8a9d-7f1bd6f04a19')
  })
})

describe('设备定位权限边界', () => {
  it('只对主窗口放行精确或近似定位权限', () => {
    const main = read('src/main/index.js')
    expect(main).toContain("permission === 'geolocation'")
    expect(main).toContain("permission === 'geolocation-approximate'")
    expect(main).toContain('webContents === getMainWindow()?.webContents')
  })
})

describe('安装包内容边界', () => {
  it('排除本地生成的 output 目录', () => {
    expect(read('electron-builder.base.yml')).toContain("- '!output/**'")
  })
})
