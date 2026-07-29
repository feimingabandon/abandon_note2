import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AppUpdateService,
  compareVersions,
  getTargetArtifact,
  normalizeRelease,
  normalizeVersion
} from '../src/main/services/app-update.js'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('app update metadata', () => {
  it('accepts stable numeric versions only', () => {
    expect(normalizeVersion('v0.9.0')).toBe('0.9.0')
    expect(normalizeVersion('1.2.3')).toBe('1.2.3')
    expect(normalizeVersion('1.2.3-beta.1')).toBeNull()
    expect(normalizeVersion('latest')).toBeNull()
  })

  it('compares semantic version components numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.8.9', '0.9.0')).toBe(-1)
  })

  it('selects the exact artifact for each supported platform', () => {
    expect(getTargetArtifact('0.9.1', 'win32', 'x64')).toBe(
      'Abandon-Note-0.9.1-windows-x64-setup.exe'
    )
    expect(getTargetArtifact('0.9.1', 'darwin', 'x64')).toBe('Abandon-Note-0.9.1-macos-x64.dmg')
    expect(getTargetArtifact('0.9.1', 'darwin', 'arm64')).toBe('Abandon-Note-0.9.1-macos-arm64.dmg')
    expect(getTargetArtifact('0.9.1', 'linux', 'x64')).toBeNull()
  })

  it('normalizes GitHub and GitCode release asset fields', () => {
    expect(
      normalizeRelease(
        {
          tag_name: 'v0.9.1',
          name: 'Abandon Note v0.9.1',
          assets: [
            {
              name: 'file.exe',
              size: 123,
              browser_download_url: 'https://github.example/file.exe'
            }
          ]
        },
        'github'
      )
    ).toMatchObject({
      version: '0.9.1',
      source: 'github',
      assets: [{ name: 'file.exe', size: 123, url: 'https://github.example/file.exe' }]
    })

    expect(
      normalizeRelease(
        {
          tag_name: 'v0.9.1',
          attach_files: [{ file_name: 'file.exe', file_size: 456 }]
        },
        'gitcode'
      )
    ).toMatchObject({
      source: 'gitcode',
      assets: [
        {
          name: 'file.exe',
          size: 456,
          url: 'https://api.gitcode.com/api/v5/repos/zou-feiming/abandon_note2/releases/v0.9.1/attach_files/file.exe/download'
        }
      ]
    })
  })

  it('ignores draft, prerelease, and non-stable releases', () => {
    expect(normalizeRelease({ tag_name: 'v0.9.1', draft: true }, 'github')).toBeNull()
    expect(normalizeRelease({ tag_name: 'v0.9.1', prerelease: true }, 'github')).toBeNull()
    expect(normalizeRelease({ tag_name: 'v0.9.1-beta.1' }, 'github')).toBeNull()
  })

  it('queries both sources and prefers a complete GitCode release at the same version', async () => {
    const requestedUrls = []
    const service = new AppUpdateService({
      currentVersion: '0.9.0',
      platform: 'win32',
      arch: 'x64',
      downloadDirectory: 'unused',
      fetchImpl: async (url) => {
        requestedUrls.push(url)
        if (url.includes('gitcode.com')) {
          return jsonResponse({
            tag_name: 'v0.9.1',
            name: 'Abandon Note v0.9.1',
            attach_files: [
              {
                file_name: 'Abandon-Note-0.9.1-windows-x64-setup.exe',
                file_size: 2048
              },
              { file_name: 'SHA256SUMS.txt', file_size: 128 }
            ]
          })
        }
        return jsonResponse({
          tag_name: 'v0.9.1',
          assets: [
            {
              name: 'Abandon-Note-0.9.1-windows-x64-setup.exe',
              size: 2048,
              browser_download_url: 'https://github.example/setup.exe'
            },
            {
              name: 'SHA256SUMS.txt',
              size: 128,
              browser_download_url: 'https://github.example/SHA256SUMS.txt'
            }
          ]
        })
      }
    })

    await expect(service.check()).resolves.toMatchObject({
      status: 'available',
      latestVersion: '0.9.1',
      source: 'gitcode',
      onlineDownloadSupported: true,
      artifactName: 'Abandon-Note-0.9.1-windows-x64-setup.exe',
      asset: { size: 2048 }
    })
    expect(requestedUrls).toHaveLength(2)
  })

  it('uses GitHub when GitCode has no published release', async () => {
    const service = new AppUpdateService({
      currentVersion: '0.9.0',
      platform: 'darwin',
      arch: 'arm64',
      downloadDirectory: 'unused',
      fetchImpl: async (url) =>
        url.includes('gitcode.com')
          ? jsonResponse({ message: '未找到 release' }, 400)
          : jsonResponse({
              tag_name: 'v0.9.0',
              assets: [
                {
                  name: 'Abandon-Note-0.9.0-macos-arm64.dmg',
                  browser_download_url: 'https://github.example/app.dmg'
                }
              ]
            })
    })

    await expect(service.check()).resolves.toMatchObject({
      status: 'current',
      latestVersion: '0.9.0',
      source: 'github',
      onlineDownloadSupported: false,
      artifactName: 'Abandon-Note-0.9.0-macos-arm64.dmg'
    })
  })

  it('chooses the higher version even when it is available only from GitHub', async () => {
    const service = new AppUpdateService({
      currentVersion: '0.9.0',
      platform: 'darwin',
      arch: 'arm64',
      downloadDirectory: 'unused',
      fetchImpl: async (url) =>
        url.includes('gitcode.com')
          ? jsonResponse({ tag_name: 'v0.9.1', attach_files: [] })
          : jsonResponse({
              tag_name: 'v0.9.2',
              assets: [
                {
                  name: 'Abandon-Note-0.9.2-macos-arm64.dmg',
                  browser_download_url: 'https://github.example/app.dmg'
                }
              ]
            })
    })

    await expect(service.check()).resolves.toMatchObject({
      status: 'available',
      latestVersion: '0.9.2',
      source: 'github'
    })
  })

  it('uses complete GitHub assets when the same GitCode version is incomplete', async () => {
    const service = new AppUpdateService({
      currentVersion: '0.9.0',
      platform: 'win32',
      arch: 'x64',
      downloadDirectory: 'unused',
      fetchImpl: async (url) =>
        url.includes('gitcode.com')
          ? jsonResponse({
              tag_name: 'v0.9.1',
              attach_files: [{ file_name: 'Abandon-Note-0.9.1-windows-x64-setup.exe' }]
            })
          : jsonResponse({
              tag_name: 'v0.9.1',
              assets: [
                {
                  name: 'Abandon-Note-0.9.1-windows-x64-setup.exe',
                  browser_download_url: 'https://github.example/setup.exe'
                },
                {
                  name: 'SHA256SUMS.txt',
                  browser_download_url: 'https://github.example/SHA256SUMS.txt'
                }
              ]
            })
    })

    await expect(service.check()).resolves.toMatchObject({
      status: 'available',
      latestVersion: '0.9.1',
      source: 'github',
      onlineDownloadSupported: true
    })
  })

  it('distinguishes no published Release from a network failure', async () => {
    const noRelease = new AppUpdateService({
      currentVersion: '0.9.0',
      platform: 'win32',
      arch: 'x64',
      downloadDirectory: 'unused',
      fetchImpl: async () => jsonResponse({ message: 'Not Found' }, 404)
    })
    await expect(noRelease.check()).resolves.toMatchObject({
      status: 'unpublished',
      error: '当前还没有公开发布版本。首次 Release 发布后，这里会显示最新版本。'
    })

    const offline = new AppUpdateService({
      currentVersion: '0.9.0',
      platform: 'win32',
      arch: 'x64',
      downloadDirectory: 'unused',
      fetchImpl: async () => {
        throw new Error('network unavailable')
      }
    })
    await expect(offline.check()).resolves.toMatchObject({
      status: 'error',
      error: '暂时无法连接更新服务。请稍后重试，或使用下方发布页手动查看。'
    })
  })

  it('downloads a complete installer and reuses the verified existing file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'abandon-update-test-'))
    const progress = []
    let downloadRequests = 0
    const assetName = 'Abandon-Note-0.9.1-windows-x64-setup.exe'
    const payload = new TextEncoder().encode('installer payload')
    const checksum = createHash('sha256').update(payload).digest('hex')
    const service = new AppUpdateService({
      currentVersion: '0.9.0',
      platform: 'win32',
      arch: 'x64',
      downloadDirectory: directory,
      onProgress: (event) => progress.push(event),
      fetchImpl: async (url) => {
        downloadRequests += 1
        if (url.endsWith('SHA256SUMS.txt')) {
          return new Response(`${checksum}  ${assetName}\n`)
        }
        return new Response(payload, {
          headers: { 'content-length': String(payload.byteLength) }
        })
      }
    })
    service.lastCheck = {
      result: { status: 'available' },
      release: {
        assets: [
          {
            name: 'SHA256SUMS.txt',
            url: 'https://gitcode.example/SHA256SUMS.txt'
          }
        ]
      },
      asset: {
        name: assetName,
        size: payload.byteLength,
        url: 'https://gitcode.example/setup.exe'
      }
    }

    try {
      const first = await service.download()
      expect(first.reused).toBe(false)
      expect(await readFile(first.path, 'utf8')).toBe('installer payload')
      const second = await service.download()
      expect(second).toEqual({ path: first.path, reused: true })
      expect(downloadRequests).toBe(3)
      expect(progress.at(-1)).toMatchObject({ state: 'downloaded', percent: 100 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses automatic download when the release has no checksum', async () => {
    const service = new AppUpdateService({
      currentVersion: '0.9.0',
      platform: 'win32',
      arch: 'x64',
      downloadDirectory: 'unused',
      fetchImpl: async () => {
        throw new Error('installer must not be downloaded')
      }
    })
    service.lastCheck = {
      result: { status: 'available' },
      release: { assets: [] },
      asset: {
        name: 'Abandon-Note-0.9.1-windows-x64-setup.exe',
        size: 128,
        url: 'https://gitcode.example/setup.exe'
      }
    }

    await expect(service.download()).rejects.toThrow('无法取得安装包 SHA-256 校验值')
  })
})
