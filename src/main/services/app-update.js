import { createHash } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { access, mkdir, rename, rm, stat } from 'fs/promises'
import { basename, join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

export const UPDATE_LINKS = Object.freeze({
  gitee: 'https://gitee.com/zou-feiming/abandon_note2/releases',
  github: 'https://github.com/feimingabandon/abandon_note2/releases'
})

const RELEASE_ENDPOINTS = Object.freeze([
  {
    source: 'gitee',
    url: 'https://gitee.com/api/v5/repos/zou-feiming/abandon_note2/releases/latest'
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

function normalizeAsset(asset) {
  return {
    name: String(asset?.name || ''),
    size: Number(asset?.size || 0),
    url: String(
      asset?.browser_download_url ||
        asset?.download_url ||
        asset?.url_for_download ||
        asset?.url ||
        ''
    )
  }
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
    assets: Array.isArray(rawAssets) ? rawAssets.map(normalizeAsset) : []
  }
}

function manualResult({ currentVersion, platform, arch, error = null }) {
  return {
    status: error ? 'error' : 'unsupported',
    currentVersion,
    latestVersion: null,
    platform,
    arch,
    artifactName: getTargetArtifact(currentVersion, platform, arch),
    onlineDownloadSupported: platform === 'win32' && arch === 'x64',
    error
  }
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function findChecksum(checksums, artifactName) {
  const escapedName = artifactName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = checksums.match(new RegExp(`^([a-fA-F0-9]{64})\\s+\\*?${escapedName}$`, 'm'))
  return match?.[1]?.toLowerCase() || null
}

export class AppUpdateService {
  constructor({
    currentVersion,
    platform,
    arch,
    downloadDirectory,
    fetchImpl = globalThis.fetch,
    onProgress = () => {}
  }) {
    this.currentVersion = currentVersion
    this.platform = platform
    this.arch = arch
    this.downloadDirectory = downloadDirectory
    this.fetch = fetchImpl
    this.onProgress = onProgress
    this.lastCheck = null
    this.downloadPromise = null
  }

  async fetchLatestRelease() {
    const failures = []
    for (const endpoint of RELEASE_ENDPOINTS) {
      try {
        const response = await this.fetch(endpoint.url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': `Abandon-Note/${this.currentVersion}`
          },
          signal: AbortSignal.timeout(12_000)
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json()
        if (endpoint.source === 'gitee' && payload?.id) {
          try {
            const attachmentsResponse = await this.fetch(
              `https://gitee.com/api/v5/repos/zou-feiming/abandon_note2/releases/${payload.id}/attach_files?page=1&per_page=100`,
              {
                headers: {
                  Accept: 'application/json',
                  'User-Agent': `Abandon-Note/${this.currentVersion}`
                },
                signal: AbortSignal.timeout(12_000)
              }
            )
            if (attachmentsResponse.ok) payload.attach_files = await attachmentsResponse.json()
          } catch {
            // 附件接口暂时失败时仍保留版本检测结果；界面会降级到双手动下载链接。
          }
        }
        const release = normalizeRelease(payload, endpoint.source)
        if (!release) throw new Error('没有可用的稳定版本')
        return release
      } catch (error) {
        failures.push(`${endpoint.source}: ${error.message}`)
      }
    }
    throw new Error(failures.join('；'))
  }

  async check() {
    const base = manualResult({
      currentVersion: this.currentVersion,
      platform: this.platform,
      arch: this.arch
    })
    try {
      const release = await this.fetchLatestRelease()
      const artifactName = getTargetArtifact(release.version, this.platform, this.arch)
      const asset = release.assets.find((item) => item.name === artifactName && item.url)
      const comparison = compareVersions(release.version, this.currentVersion)
      const result = {
        ...base,
        status: comparison > 0 ? 'available' : 'current',
        latestVersion: release.version,
        artifactName,
        source: release.source,
        releaseTitle: release.title,
        releaseNotes: release.notes,
        publishedAt: release.publishedAt,
        onlineDownloadSupported: Boolean(
          comparison > 0 && this.platform === 'win32' && this.arch === 'x64' && asset
        ),
        asset: asset ? { name: asset.name, size: asset.size } : null,
        error:
          comparison > 0 && this.platform === 'win32' && !asset
            ? '当前发布中没有找到适用于本机的 Windows 安装包'
            : null
      }
      this.lastCheck = { result, release, asset }
      return result
    } catch (error) {
      const result = manualResult({
        currentVersion: this.currentVersion,
        platform: this.platform,
        arch: this.arch,
        error: `暂时无法获取最新版本：${error.message}`
      })
      this.lastCheck = { result, release: null, asset: null }
      return result
    }
  }

  async getExpectedChecksum(release, artifactName) {
    const checksumAsset = release.assets.find(
      (asset) => asset.name === 'SHA256SUMS.txt' && asset.url
    )
    if (!checksumAsset) return null
    const response = await this.fetch(checksumAsset.url, {
      headers: { 'User-Agent': `Abandon-Note/${this.currentVersion}` },
      signal: AbortSignal.timeout(12_000)
    })
    if (!response.ok) return null
    return findChecksum(await response.text(), artifactName)
  }

  async download() {
    if (this.downloadPromise) return this.downloadPromise
    this.downloadPromise = this.performDownload().finally(() => {
      this.downloadPromise = null
    })
    return this.downloadPromise
  }

  async performDownload() {
    if (this.platform !== 'win32' || this.arch !== 'x64') {
      throw new Error('当前系统仅支持手动下载安装包')
    }
    if (!this.lastCheck || this.lastCheck.result.status !== 'available') await this.check()
    const { result, release, asset } = this.lastCheck
    if (result.status !== 'available') throw new Error('当前没有可下载的新版本')
    if (!asset?.url) throw new Error('发布中没有找到适用于本机的 Windows 安装包')

    await mkdir(this.downloadDirectory, { recursive: true })
    const destination = join(this.downloadDirectory, basename(asset.name))
    const partial = `${destination}.part`
    const expectedChecksum = await this.getExpectedChecksum(release, asset.name).catch(() => null)

    if (await fileExists(destination)) {
      const existing = await stat(destination)
      const sizeMatches = !asset.size || existing.size === asset.size
      const hashMatches = !expectedChecksum || (await sha256File(destination)) === expectedChecksum
      if (sizeMatches && hashMatches) {
        this.onProgress({ state: 'downloaded', percent: 100, path: destination })
        return { path: destination, reused: true }
      }
      await rm(destination, { force: true })
    }

    await rm(partial, { force: true })
    const response = await this.fetch(asset.url, {
      headers: { 'User-Agent': `Abandon-Note/${this.currentVersion}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(30 * 60_000)
    })
    if (!response.ok || !response.body) throw new Error(`下载安装包失败：HTTP ${response.status}`)

    const total = Number(response.headers.get('content-length')) || asset.size || 0
    let received = 0
    const source = Readable.fromWeb(response.body)
    source.on('data', (chunk) => {
      received += chunk.length
      this.onProgress({
        state: 'downloading',
        received,
        total,
        percent: total ? Math.min(99, Math.round((received / total) * 100)) : null
      })
    })

    try {
      await pipeline(source, createWriteStream(partial, { flags: 'wx' }))
      const downloaded = await stat(partial)
      if (asset.size && downloaded.size !== asset.size) throw new Error('安装包大小校验失败')
      if (expectedChecksum && (await sha256File(partial)) !== expectedChecksum) {
        throw new Error('安装包 SHA-256 校验失败')
      }
      await rename(partial, destination)
      this.onProgress({ state: 'downloaded', percent: 100, path: destination })
      return { path: destination, reused: false }
    } catch (error) {
      await rm(partial, { force: true })
      this.onProgress({ state: 'error', error: error.message })
      throw error
    }
  }
}
