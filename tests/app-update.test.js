import { describe, expect, it } from 'vitest'
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

  it('normalizes GitHub and Gitee release asset fields', () => {
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
          attach_files: [{ name: 'file.exe', download_url: 'https://gitee.example/file.exe' }]
        },
        'gitee'
      ).assets[0].url
    ).toBe('https://gitee.example/file.exe')
  })

  it('ignores draft, prerelease, and non-stable releases', () => {
    expect(normalizeRelease({ tag_name: 'v0.9.1', draft: true }, 'github')).toBeNull()
    expect(normalizeRelease({ tag_name: 'v0.9.1', prerelease: true }, 'github')).toBeNull()
    expect(normalizeRelease({ tag_name: 'v0.9.1-beta.1' }, 'github')).toBeNull()
  })

  it('loads Gitee attachments separately and enables the Windows download', async () => {
    const requestedUrls = []
    const service = new AppUpdateService({
      currentVersion: '0.9.0',
      platform: 'win32',
      arch: 'x64',
      downloadDirectory: 'unused',
      fetchImpl: async (url) => {
        requestedUrls.push(url)
        if (url.endsWith('/releases/latest')) {
          return jsonResponse({ id: 7, tag_name: 'v0.9.1', name: 'Abandon Note v0.9.1' })
        }
        return jsonResponse([
          {
            name: 'Abandon-Note-0.9.1-windows-x64-setup.exe',
            size: 2048,
            browser_download_url: 'https://gitee.example/setup.exe'
          }
        ])
      }
    })

    await expect(service.check()).resolves.toMatchObject({
      status: 'available',
      latestVersion: '0.9.1',
      source: 'gitee',
      onlineDownloadSupported: true,
      artifactName: 'Abandon-Note-0.9.1-windows-x64-setup.exe',
      asset: { size: 2048 }
    })
    expect(requestedUrls[1]).toContain('/releases/7/attach_files')
  })

  it('falls back to GitHub when Gitee has no published release', async () => {
    const service = new AppUpdateService({
      currentVersion: '0.9.0',
      platform: 'darwin',
      arch: 'arm64',
      downloadDirectory: 'unused',
      fetchImpl: async (url) =>
        url.includes('gitee.com')
          ? jsonResponse({ message: 'Not Found' }, 404)
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

  it('downloads a complete installer and reuses the verified existing file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'abandon-update-test-'))
    const progress = []
    let downloadRequests = 0
    const assetName = 'Abandon-Note-0.9.1-windows-x64-setup.exe'
    const payload = new TextEncoder().encode('installer payload')
    const service = new AppUpdateService({
      currentVersion: '0.9.0',
      platform: 'win32',
      arch: 'x64',
      downloadDirectory: directory,
      onProgress: (event) => progress.push(event),
      fetchImpl: async () => {
        downloadRequests += 1
        return new Response(payload, {
          headers: { 'content-length': String(payload.byteLength) }
        })
      }
    })
    service.lastCheck = {
      result: { status: 'available' },
      release: { assets: [] },
      asset: {
        name: assetName,
        size: payload.byteLength,
        url: 'https://gitee.example/setup.exe'
      }
    }

    try {
      const first = await service.download()
      expect(first.reused).toBe(false)
      expect(await readFile(first.path, 'utf8')).toBe('installer payload')
      const second = await service.download()
      expect(second).toEqual({ path: first.path, reused: true })
      expect(downloadRequests).toBe(1)
      expect(progress.at(-1)).toMatchObject({ state: 'downloaded', percent: 100 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
