const { Arch } = require('builder-util')

const NATIVE_TARGETS = Object.freeze({
  win32: Object.freeze({
    x64: Object.freeze({
      required: Object.freeze([
        'better-sqlite3/prebuilds/win32-x64.node',
        'koffi/build/koffi/win32_x64/koffi.node'
      ]),
      excludePatterns: Object.freeze([
        '!node_modules/better-sqlite3/prebuilds/darwin-*.node',
        '!node_modules/koffi/build/koffi/darwin_*/**'
      ]),
      requiresWindowsBlur: true
    })
  }),
  darwin: Object.freeze({
    x64: Object.freeze({
      required: Object.freeze([
        'better-sqlite3/prebuilds/darwin-x64.node',
        'koffi/build/koffi/darwin_x64/koffi.node'
      ]),
      excludePatterns: Object.freeze([
        '!node_modules/better-sqlite3/prebuilds/win32-x64.node',
        '!node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
        '!node_modules/koffi/build/koffi/win32_x64/**',
        '!node_modules/koffi/build/koffi/darwin_arm64/**'
      ]),
      requiresWindowsBlur: false
    }),
    arm64: Object.freeze({
      required: Object.freeze([
        'better-sqlite3/prebuilds/darwin-arm64.node',
        'koffi/build/koffi/darwin_arm64/koffi.node'
      ]),
      excludePatterns: Object.freeze([
        '!node_modules/better-sqlite3/prebuilds/win32-x64.node',
        '!node_modules/better-sqlite3/prebuilds/darwin-x64.node',
        '!node_modules/koffi/build/koffi/win32_x64/**',
        '!node_modules/koffi/build/koffi/darwin_x64/**'
      ]),
      requiresWindowsBlur: false
    })
  })
})

const ALL_NATIVE_FILES = Object.freeze(
  Array.from(
    new Set(
      Object.values(NATIVE_TARGETS).flatMap((plans) =>
        Object.values(plans).flatMap((plan) => plan.required)
      )
    )
  )
)

function resolveNativeTarget(context) {
  const platform = context.electronPlatformName
  const arch = typeof context.arch === 'string' ? context.arch : Arch[context.arch]
  const plan = NATIVE_TARGETS[platform]?.[arch]

  if (!plan) {
    throw new Error(`Unsupported native package target: ${platform}-${arch}`)
  }

  return {
    platform,
    arch,
    ...plan,
    forbidden: ALL_NATIVE_FILES.filter((relativePath) => !plan.required.includes(relativePath))
  }
}

module.exports = { ALL_NATIVE_FILES, NATIVE_TARGETS, resolveNativeTarget }
