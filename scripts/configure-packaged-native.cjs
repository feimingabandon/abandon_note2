const { resolveNativeTarget } = require('./package-native-plan.cjs')

function collectFilePatterns(files) {
  if (!Array.isArray(files)) return typeof files === 'string' ? [files] : []

  return files.flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    if (!entry || !entry.filter) return []
    return Array.isArray(entry.filter) ? entry.filter : [entry.filter]
  })
}

async function configurePackagedNative(context) {
  const target = resolveNativeTarget(context)
  const config = context.packager.config
  const files = Array.isArray(config.files) ? config.files : config.files ? [config.files] : []
  const existingPatterns = new Set(collectFilePatterns(files))
  const defaultFileSet = files.find(
    (entry) => entry && typeof entry === 'object' && entry.from == null && entry.to == null
  )

  // electron-builder 在读取配置时会把顶层 files 规范化为 FileSet 对象。
  // 此时若直接向数组追加字符串，会额外创建一个“仅含排除规则”的 matcher；该 matcher
  // 会被自动补成 **/*，反而把整个仓库复制进 ASAR。必须把规则合并进原有默认 FileSet。
  if (!defaultFileSet) {
    throw new Error(
      'Default application file set is missing; cannot apply native exclusions safely'
    )
  }

  const filters = Array.isArray(defaultFileSet.filter)
    ? defaultFileSet.filter
    : defaultFileSet.filter
      ? [defaultFileSet.filter]
      : []

  for (const pattern of target.excludePatterns) {
    if (!existingPatterns.has(pattern)) filters.push(pattern)
  }

  defaultFileSet.filter = filters
  config.files = files
  console.log(`[package-config] selected ${target.platform}-${target.arch} native modules`)
}

exports.default = configurePackagedNative
exports.collectFilePatterns = collectFilePatterns
