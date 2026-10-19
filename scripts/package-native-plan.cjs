const { Arch } = require('builder-util')

const NATIVE_TARGETS = Object.freeze({
  win32: Object.freeze({
    x64: Object.freeze({
      required: Object.freeze([
        'better-sqlite3/prebuilds/win32-x64.node',
        'koffi/build/koffi/win32_x64/koffi.node'
      ]),
      binaryScopes: Object.freeze(['better-sqlite3/prebuilds', 'koffi/build/koffi']),
      excludePatterns: Object.freeze([
        // 允许列表排除未知平台和未来新增架构，不能只枚举当前发布的非目标名称。
        '!node_modules/better-sqlite3/prebuilds/!(win32-x64.node)',
        '!node_modules/better-sqlite3/prebuilds/*/**',
        '!node_modules/koffi/build/koffi/!(win32_x64){,/**}',
        '!node_modules/koffi/build/koffi/win32_x64/!(koffi.node)',
        '!node_modules/koffi/build/koffi/win32_x64/*/**'
      ])
    })
  })
})

function resolveNativeTarget(context) {
  const platform = context.electronPlatformName
  const arch = typeof context.arch === 'string' ? context.arch : Arch[context.arch]
  const plan = platform === 'win32' && arch === 'x64' ? NATIVE_TARGETS.win32.x64 : null

  if (!plan) {
    throw new Error(`Unsupported native package target: ${platform}-${arch}`)
  }

  return { platform, arch, ...plan }
}

module.exports = { NATIVE_TARGETS, resolveNativeTarget }
