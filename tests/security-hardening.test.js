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

describe('macOS 发布加固', () => {
  it('启用 Hardened Runtime、签名继承和公证，并只声明实际使用的定位权限', () => {
    const config = read('electron-builder.yml')
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

  it('在发布工作流中把 API 私钥写入临时 p8 文件', () => {
    const workflow = read('.github/workflows/release.yml')
    expect(workflow).toContain('AuthKey_${APPLE_API_KEY_ID}.p8')
    expect(workflow).toContain('openssl base64 -d -A')
    expect(workflow).toContain('echo "APPLE_API_KEY=$api_key_path" >> "$GITHUB_ENV"')
  })
})
