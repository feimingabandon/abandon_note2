import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

describe('渲染入口 CSP', () => {
  it.each(['index.html', 'month.html', 'week.html', 'sticky.html'])(
    '%s 禁止插件、base 重写和表单外传',
    (entry) => {
      const html = read(`src/renderer/${entry}`)
      expect(html).toContain("object-src 'none'")
      expect(html).toContain("base-uri 'none'")
      expect(html).toContain("form-action 'none'")
    }
  )
})

describe('macOS 保留构建配置', () => {
  it('启用 Hardened Runtime、签名继承和公证，并只声明实际使用的定位权限', () => {
    const config = read('electron-builder.mac.yml')
    expect(config).toContain('hardenedRuntime: true')
    expect(config).toContain('entitlements: build/entitlements.mac.plist')
    expect(config).toContain('entitlementsInherit: build/entitlements.mac.plist')
    expect(config).toContain('NSLocationUsageDescription:')
    expect(config).toContain('notarize: true')
    expect(config).not.toContain('identity: null')
    expect(config).not.toContain('NSCameraUsageDescription')
    expect(config).not.toContain('NSMicrophoneUsageDescription')
  })

  it('不再授权未签名可执行内存或 DYLD 环境变量', () => {
    const entitlements = read('build/entitlements.mac.plist')
    expect(entitlements).toContain('com.apple.security.cs.allow-jit')
    expect(entitlements).not.toContain('allow-unsigned-executable-memory')
    expect(entitlements).not.toContain('allow-dyld-environment-variables')
  })

  it('当前正式发布工作流只生成 Windows 资产', () => {
    const workflow = read('.github/workflows/release.yml')
    expect(workflow).toContain('--config electron-builder.win.yml --win nsis --x64')
    expect(workflow).not.toContain('  macos:')
    expect(workflow).not.toContain('APPLE_API_KEY')
    expect(workflow).not.toContain('MAC_CSC_LINK')
  })
})

describe('应用与安装器身份', () => {
  it('统一使用 com.abandon.note，并保留旧版 NSIS 升级身份', () => {
    expect(read('src/main/index.js')).toContain("const APP_ID = 'com.abandon.note'")
    expect(read('electron-builder.base.yml')).toContain('appId: com.abandon.note')
    expect(read('electron-builder.win.yml')).toContain('guid: 41249b74-bbe0-5d8d-8a9d-7f1bd6f04a19')
  })
})

describe('安装包内容边界', () => {
  it('排除本地生成的 output 目录', () => {
    expect(read('electron-builder.base.yml')).toContain("- '!output/**'")
  })
})
