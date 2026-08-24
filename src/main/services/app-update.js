import { randomUUID } from 'node:crypto'

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

const RELEASE_PAGE_BUILDERS = Object.freeze({
  gitcode: (version) => `https://gitcode.com/zou-feiming/abandon_note2/releases/tag/v${version}`,
  github: (version) => `https://github.com/feimingabandon/abandon_note2/releases/tag/v${version}`
})

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

// 当前更新入口仅面向 Windows 10/11 x64；macOS 下载暂不在应用内提供。
export function getTargetArtifact(version, platform, arch) {
  const normalizedVersion = normalizeVersion(version)
  if (!normalizedVersion) throw new Error('无法为无效版本确定安装包')
  if (platform === 'win32' && arch === 'x64') {
    return `Abandon-Note-${normalizedVersion}-windows-x64-setup.exe`
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
          size: Number(asset?.size || asset?.file_size || 0),
          downloadUrl: String(asset?.browser_download_url || asset?.download_url || '')
        }))
      : []
  }
}

function hasTargetArtifact(release, platform, arch) {
  const artifactName = getTargetArtifact(release.version, platform, arch)
  if (!artifactName) return false
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

function buildReleaseLinks(version) {
  const normalizedVersion = normalizeVersion(version)
  if (!normalizedVersion) throw new Error('无法为无效版本生成发布页地址')
  return {
    gitcode: RELEASE_PAGE_BUILDERS.gitcode(normalizedVersion),
    github: RELEASE_PAGE_BUILDERS.github(normalizedVersion)
  }
}

function getTrustedGitCodeDownloadUrl(release, artifactName) {
  if (release?.source !== 'gitcode' || !artifactName) return null
  const asset = release.assets.find((item) => item.name === artifactName)
  if (!asset?.downloadUrl) return null

  try {
    const url = new URL(asset.downloadUrl)
    const expectedPath = `/zou-feiming/abandon_note2/releases/download/v${release.version}/${artifactName}`
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'gitcode.com' ||
      decodeURIComponent(url.pathname) !== expectedPath
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

function emptyResult({ currentVersion, platform, arch, status = 'unsupported', error = null }) {
  return {
    status,
    relation: null,
    checkId: null,
    currentVersion,
    latestVersion: null,
    platform,
    arch,
    artifactName: null,
    downloadAvailable: false,
    downloadUrl: null,
    releaseLinks: null,
    error
  }
}

// 应用只检查版本并打开受信的浏览器地址；安装包下载和安装继续由浏览器与用户完成。
export class AppUpdateService {
  constructor({
    currentVersion,
    platform,
    arch,
    fetchImpl = globalThis.fetch,
    checkEnabled = true
  }) {
    this.currentVersion = currentVersion
    this.platform = platform
    this.arch = arch
    this.fetch = fetchImpl
    this.checkEnabled = checkEnabled
    this.externalSelection = null
  }

  async fetchLatestReleases() {
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
    if (releases.length > 0) return releases

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

  getExternalUrl({ target, checkId, targetVersion, relation } = {}) {
    const selection = this.externalSelection
    if (
      !selection ||
      selection.checkId !== checkId ||
      selection.targetVersion !== normalizeVersion(targetVersion) ||
      selection.relation !== relation
    ) {
      throw new Error('更新检查结果已经过期，请重新检查')
    }
    const url = selection.urls[target]
    if (!url) {
      throw new Error(
        target === 'download'
          ? 'GitCode 最新版安装包暂不可用，请稍后重试或使用手动下载'
          : '请先完成更新检查'
      )
    }
    return url
  }

  async check() {
    this.externalSelection = null
    const base = emptyResult({
      currentVersion: this.currentVersion,
      platform: this.platform,
      arch: this.arch
    })
    const currentArtifactName = getTargetArtifact(this.currentVersion, this.platform, this.arch)
    if (!currentArtifactName) {
      return {
        ...base,
        status: 'unsupported',
        error: '当前更新下载暂时只提供 Windows x64 安装包。'
      }
    }
    if (!this.checkEnabled) {
      return {
        ...base,
        status: 'current',
        relation: 'same',
        latestVersion: this.currentVersion,
        artifactName: currentArtifactName
      }
    }

    try {
      const releases = await this.fetchLatestReleases()
      const release = selectPreferredRelease(releases, this.platform, this.arch)
      const comparison = compareVersions(release.version, this.currentVersion)
      const relation = comparison > 0 ? 'upgrade' : comparison === 0 ? 'same' : 'downgrade'
      const checkId = randomUUID()
      const artifactName = getTargetArtifact(release.version, this.platform, this.arch)
      const gitcodeRelease = releases.find(
        (candidate) =>
          candidate.source === 'gitcode' &&
          compareVersions(candidate.version, release.version) === 0
      )
      const sameVersionReleases = releases.filter(
        (candidate) => compareVersions(candidate.version, release.version) === 0
      )
      const notesRelease =
        sameVersionReleases.find(
          (candidate) => candidate.source === 'github' && candidate.notes.trim()
        ) || sameVersionReleases.find((candidate) => candidate.notes.trim())
      const downloadUrl = getTrustedGitCodeDownloadUrl(gitcodeRelease, artifactName)
      const releaseLinks = buildReleaseLinks(release.version)
      this.externalSelection = Object.freeze({
        checkId,
        targetVersion: release.version,
        relation,
        urls: Object.freeze({
          download: downloadUrl,
          gitcode: releaseLinks.gitcode,
          github: releaseLinks.github
        })
      })

      const result = {
        ...base,
        status:
          relation === 'upgrade' ? 'available' : relation === 'same' ? 'current' : 'downgrade',
        relation,
        checkId,
        latestVersion: release.version,
        artifactName,
        downloadAvailable: Boolean(downloadUrl),
        downloadUrl,
        releaseLinks,
        source: release.source,
        releaseTitle: release.title,
        releaseNotes: notesRelease?.notes || '',
        publishedAt: release.publishedAt
      }
      console.log(
        `[update] 检查完成: 当前 ${this.currentVersion} / 最新 ${release.version} (${release.source}), 状态 ${result.status}, GitCode 下载 ${downloadUrl ? '可用' : '不可用'}`
      )
      return result
    } catch (error) {
      const unpublished = error.code === 'NO_PUBLISHED_RELEASE'
      console.error('[update] 检查更新失败:', error)
      return emptyResult({
        currentVersion: this.currentVersion,
        platform: this.platform,
        arch: this.arch,
        status: unpublished ? 'unpublished' : 'error',
        error: unpublished
          ? '当前还没有公开发布版本。首次 Release 发布后，这里会显示最新版本。'
          : '暂时无法连接更新服务，请稍后重试。'
      })
    }
  }
}
