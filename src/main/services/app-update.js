export const UPDATE_LINKS = Object.freeze({
  gitcode: 'https://gitcode.com/zou-feiming/abandon_note2/releases',
  github: 'https://github.com/feimingabandon/abandon_note2/releases'
})

const RELEASE_ENDPOINTS = Object.freeze([
  {
    source: 'gitcode',
    url: 'https://api.gitcode.com/api/v5/repos/zou-feiming/abandon_note2/releases/latest'
  },
  {
    source: 'github',
    url: 'https://api.github.com/repos/feimingabandon/abandon_note2/releases/latest'
  }
])

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

export function normalizeVersion(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/^v/i, '')
  return VERSION_PATTERN.test(normalized) ? normalized : null
}

export function compareVersions(left, right) {
  const a = normalizeVersion(left)
  const b = normalizeVersion(right)
  if (!a || !b) throw new Error('版本号必须是稳定的数字语义版本')
  const aParts = a.split('.').map(Number)
  const bParts = b.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (aParts[index] !== bParts[index]) return aParts[index] > bParts[index] ? 1 : -1
  }
  return 0
}

export function getTargetArtifact(version, platform, arch) {
  const normalizedVersion = normalizeVersion(version)
  if (!normalizedVersion) throw new Error('无法为无效版本确定安装包')
  if (platform === 'win32' && arch === 'x64') {
    return `Abandon-Note-${normalizedVersion}-windows-x64-setup.exe`
  }
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    return `Abandon-Note-${normalizedVersion}-macos-${arch}.dmg`
  }
  return null
}

export function normalizeRelease(payload, source) {
  const version = normalizeVersion(payload?.tag_name)
  if (!version || payload?.draft || payload?.prerelease) return null
  const rawAssets = payload?.assets || payload?.attach_files || payload?.attachments || []
  return {
    source,
    version,
    title: String(payload?.name || payload?.tag_name || `v${version}`),
    notes: String(payload?.body || ''),
    publishedAt: String(payload?.published_at || payload?.created_at || ''),
    assets: Array.isArray(rawAssets)
      ? rawAssets.map((asset) => ({
          name: String(asset?.name || asset?.file_name || ''),
          size: Number(asset?.size || asset?.file_size || 0)
        }))
      : []
  }
}

function hasTargetArtifact(release, platform, arch) {
  const artifactName = getTargetArtifact(release.version, platform, arch)
  if (!artifactName) return true
  return release.assets.some((asset) => asset.name === artifactName)
}

function selectPreferredRelease(releases, platform, arch) {
  const highestVersion = releases.reduce(
    (highest, release) =>
      compareVersions(release.version, highest) > 0 ? release.version : highest,
    releases[0].version
  )
  const candidates = releases.filter(
    (release) => compareVersions(release.version, highestVersion) === 0
  )
  return (
    candidates.find(
      (release) => release.source === 'gitcode' && hasTargetArtifact(release, platform, arch)
    ) ||
    candidates.find(
      (release) => release.source === 'github' && hasTargetArtifact(release, platform, arch)
    ) ||
    candidates.find((release) => release.source === 'gitcode') ||
    candidates[0]
  )
}

function manualResult({ currentVersion, platform, arch, status = 'unsupported', error = null }) {
  return {
    status,
    currentVersion,
    latestVersion: null,
    platform,
    arch,
    artifactName: getTargetArtifact(currentVersion, platform, arch),
    error
  }
}

// 更新采用全手动模式：应用只负责检查新版本，下载安装由用户前往发布页完成。
export class AppUpdateService {
  constructor({ currentVersion, platform, arch, fetchImpl = globalThis.fetch }) {
    this.currentVersion = currentVersion
    this.platform = platform
    this.arch = arch
    this.fetch = fetchImpl
  }

  async fetchLatestRelease() {
    const attempts = await Promise.all(
      RELEASE_ENDPOINTS.map(async (endpoint) => {
        try {
          const response = await this.fetch(endpoint.url, {
            headers: {
              Accept: 'application/json',
              'User-Agent': `Abandon-Note/${this.currentVersion}`
            },
            signal: AbortSignal.timeout(12_000)
          })
          if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`)
            error.code =
              response.status === 404 || (endpoint.source === 'gitcode' && response.status === 400)
                ? 'RELEASE_NOT_FOUND'
                : 'RELEASE_HTTP_ERROR'
            throw error
          }
          const payload = await response.json()
          const release = normalizeRelease(payload, endpoint.source)
          if (!release) throw new Error('没有可用的稳定版本')
          return { release, failure: null }
        } catch (error) {
          console.warn(`[update] 获取 ${endpoint.source} 发布信息失败 (${endpoint.url}):`, error)
          return {
            release: null,
            failure: {
              source: endpoint.source,
              code: error.code || 'RELEASE_REQUEST_FAILED',
              message: error.message
            }
          }
        }
      })
    )
    const releases = attempts.map((attempt) => attempt.release).filter(Boolean)
    if (releases.length > 0) {
      return selectPreferredRelease(releases, this.platform, this.arch)
    }
    const failures = attempts.map((attempt) => attempt.failure).filter(Boolean)
    const error = new Error(
      failures.map((failure) => `${failure.source}: ${failure.message}`).join('；')
    )
    if (
      failures.length === RELEASE_ENDPOINTS.length &&
      failures.every((failure) => failure.code === 'RELEASE_NOT_FOUND')
    ) {
      error.code = 'NO_PUBLISHED_RELEASE'
    }
    throw error
  }

  async check() {
    const base = manualResult({
      currentVersion: this.currentVersion,
      platform: this.platform,
      arch: this.arch
    })
    try {
      const release = await this.fetchLatestRelease()
      const comparison = compareVersions(release.version, this.currentVersion)
      const result = {
        ...base,
        status: comparison > 0 ? 'available' : 'current',
        latestVersion: release.version,
        artifactName: getTargetArtifact(release.version, this.platform, this.arch),
        source: release.source,
        releaseTitle: release.title,
        releaseNotes: release.notes,
        publishedAt: release.publishedAt
      }
      console.log(
        `[update] 检查完成: 当前 ${this.currentVersion} / 最新 ${release.version} (${release.source}), 状态 ${result.status}`
      )
      return result
    } catch (error) {
      const unpublished = error.code === 'NO_PUBLISHED_RELEASE'
      console.error('[update] 检查更新失败:', error)
      return manualResult({
        currentVersion: this.currentVersion,
        platform: this.platform,
        arch: this.arch,
        status: unpublished ? 'unpublished' : 'error',
        error: unpublished
          ? '当前还没有公开发布版本。首次 Release 发布后，这里会显示最新版本。'
          : '暂时无法连接更新服务。请稍后重试，或使用下方发布页手动查看。'
      })
    }
  }
}
