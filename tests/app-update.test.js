import { describe, expect, it } from 'vitest'
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

function windowsAsset(version, source, overrides = {}) {
  const name = `Abandon-Note-${version}-windows-x64-setup.exe`
  if (source === 'gitcode') {
    return {
      name,
      size: 2048,
      browser_download_url: `https://gitcode.com/zou-feiming/abandon_note2/releases/download/v${version}/${name}`,
      ...overrides
    }
  }
  return {
    name,
    size: 2048,
    browser_download_url: `https://github.com/feimingabandon/abandon_note2/releases/download/v${version}/${name}`,
    ...overrides
  }
}

function linkRequest(result, target) {
  return {
    target,
    checkId: result.checkId,
    targetVersion: result.latestVersion,
    relation: result.relation
  }
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

  it('only exposes the Windows x64 installer in the application updater', () => {
    expect(getTargetArtifact('0.9.2', 'win32', 'x64')).toBe(
      'Abandon-Note-0.9.2-windows-x64-setup.exe'
    )
    expect(getTargetArtifact('0.9.2', 'darwin', 'x64')).toBeNull()
    expect(getTargetArtifact('0.9.2', 'darwin', 'arm64')).toBeNull()
    expect(getTargetArtifact('0.9.2', 'linux', 'x64')).toBeNull()
  })

  it('keeps the browser download URL returned by release APIs', () => {
    const release = normalizeRelease(
      {
        tag_name: 'v0.9.2',
        name: 'Abandon Note v0.9.2',
        assets: [windowsAsset('0.9.2', 'gitcode')]
      },
      'gitcode'
    )

    expect(release).toMatchObject({
      version: '0.9.2',
      source: 'gitcode',
      assets: [
        {
          name: 'Abandon-Note-0.9.2-windows-x64-setup.exe',
          size: 2048,
          downloadUrl:
            'https://gitcode.com/zou-feiming/abandon_note2/releases/download/v0.9.2/Abandon-Note-0.9.2-windows-x64-setup.exe'
        }
      ]
    })
  })

  it('ignores draft, prerelease, and non-stable releases', () => {
    expect(normalizeRelease({ tag_name: 'v0.9.2', draft: true }, 'github')).toBeNull()
    expect(normalizeRelease({ tag_name: 'v0.9.2', prerelease: true }, 'github')).toBeNull()
    expect(normalizeRelease({ tag_name: 'v0.9.2-beta.1' }, 'github')).toBeNull()
  })

  it('can suppress network checks in full-app integration environments', async () => {
    let requestCount = 0
    const service = new AppUpdateService({
      currentVersion: '1.0.0',
      platform: 'win32',
      arch: 'x64',
      checkEnabled: false,
      fetchImpl: async () => {
        requestCount += 1
        throw new Error('integration tests must not access release APIs')
      }
    })

    await expect(service.check()).resolves.toMatchObject({
      status: 'current',
      relation: 'same',
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      artifactName: 'Abandon-Note-1.0.0-windows-x64-setup.exe',
      downloadAvailable: false
    })
    expect(requestCount).toBe(0)
  })

  it('still provides direct and manual downloads when the app is already current', async () => {
    const requestedUrls = []
    const service = new AppUpdateService({
      currentVersion: '0.9.2',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async (url) => {
        requestedUrls.push(url)
        const source = url.includes('gitcode.com') ? 'gitcode' : 'github'
        return jsonResponse({
          tag_name: 'v0.9.2',
          name: 'Abandon Note v0.9.2',
          assets: [windowsAsset('0.9.2', source)]
        })
      }
    })

    const result = await service.check()
    expect(result).toMatchObject({
      status: 'current',
      relation: 'same',
      currentVersion: '0.9.2',
      latestVersion: '0.9.2',
      artifactName: 'Abandon-Note-0.9.2-windows-x64-setup.exe',
      downloadAvailable: true,
      downloadUrl:
        'https://gitcode.com/zou-feiming/abandon_note2/releases/download/v0.9.2/Abandon-Note-0.9.2-windows-x64-setup.exe',
      releaseLinks: {
        gitcode: 'https://gitcode.com/zou-feiming/abandon_note2/releases/tag/v0.9.2',
        github: 'https://github.com/feimingabandon/abandon_note2/releases/tag/v0.9.2'
      }
    })
    expect(service.getExternalUrl(linkRequest(result, 'download'))).toContain(
      '/releases/download/v0.9.2/'
    )
    expect(service.getExternalUrl(linkRequest(result, 'gitcode'))).toBe(
      'https://gitcode.com/zou-feiming/abandon_note2/releases/tag/v0.9.2'
    )
    expect(service.getExternalUrl(linkRequest(result, 'github'))).toBe(
      'https://github.com/feimingabandon/abandon_note2/releases/tag/v0.9.2'
    )
    expect(requestedUrls).toHaveLength(2)
  })

  it('offers the same three targets when a newer version is available', async () => {
    const service = new AppUpdateService({
      currentVersion: '0.9.1',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async (url) => {
        const source = url.includes('gitcode.com') ? 'gitcode' : 'github'
        return jsonResponse({
          tag_name: 'v0.9.2',
          assets: [windowsAsset('0.9.2', source)]
        })
      }
    })

    await expect(service.check()).resolves.toMatchObject({
      status: 'available',
      relation: 'upgrade',
      latestVersion: '0.9.2',
      downloadAvailable: true,
      releaseLinks: {
        gitcode: 'https://gitcode.com/zou-feiming/abandon_note2/releases/tag/v0.9.2',
        github: 'https://github.com/feimingabandon/abandon_note2/releases/tag/v0.9.2'
      }
    })
  })

  it('keeps manual version pages but disables direct download while GitCode is behind', async () => {
    const service = new AppUpdateService({
      currentVersion: '0.9.0',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async (url) =>
        url.includes('gitcode.com')
          ? jsonResponse({ tag_name: 'v0.9.1', assets: [windowsAsset('0.9.1', 'gitcode')] })
          : jsonResponse({ tag_name: 'v0.9.2', assets: [windowsAsset('0.9.2', 'github')] })
    })

    const result = await service.check()
    expect(result).toMatchObject({
      status: 'available',
      latestVersion: '0.9.2',
      source: 'github',
      downloadAvailable: false,
      downloadUrl: null,
      releaseLinks: {
        gitcode: 'https://gitcode.com/zou-feiming/abandon_note2/releases/tag/v0.9.2',
        github: 'https://github.com/feimingabandon/abandon_note2/releases/tag/v0.9.2'
      }
    })
    expect(() => service.getExternalUrl(linkRequest(result, 'download'))).toThrow('安装包暂不可用')
  })

  it('labels an older public release as a downgrade and binds links to that check', async () => {
    const service = new AppUpdateService({
      currentVersion: '1.0.0',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async (url) => {
        const source = url.includes('gitcode.com') ? 'gitcode' : 'github'
        return jsonResponse({
          tag_name: 'v0.9.2',
          assets: [windowsAsset('0.9.2', source)]
        })
      }
    })

    const result = await service.check()
    expect(result).toMatchObject({
      status: 'downgrade',
      relation: 'downgrade',
      currentVersion: '1.0.0',
      latestVersion: '0.9.2',
      downloadAvailable: true
    })
    expect(service.getExternalUrl(linkRequest(result, 'download'))).toContain(
      '/releases/download/v0.9.2/'
    )
    expect(() =>
      service.getExternalUrl({ ...linkRequest(result, 'download'), relation: 'upgrade' })
    ).toThrow('已经过期')
  })

  it('rejects links from a superseded update check', async () => {
    const service = new AppUpdateService({
      currentVersion: '0.9.1',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async (url) => {
        const source = url.includes('gitcode.com') ? 'gitcode' : 'github'
        return jsonResponse({
          tag_name: 'v0.9.2',
          assets: [windowsAsset('0.9.2', source)]
        })
      }
    })

    const first = await service.check()
    const second = await service.check()
    expect(first.checkId).not.toBe(second.checkId)
    expect(() => service.getExternalUrl(linkRequest(first, 'github'))).toThrow('已经过期')
    expect(service.getExternalUrl(linkRequest(second, 'github'))).toContain('/tag/v0.9.2')
  })

  it('rejects an untrusted URL even when the GitCode asset name matches', async () => {
    const service = new AppUpdateService({
      currentVersion: '0.9.2',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async (url) => {
        const source = url.includes('gitcode.com') ? 'gitcode' : 'github'
        return jsonResponse({
          tag_name: 'v0.9.2',
          assets: [
            windowsAsset('0.9.2', source, {
              browser_download_url:
                source === 'gitcode'
                  ? 'https://example.com/Abandon-Note-0.9.2-windows-x64-setup.exe'
                  : windowsAsset('0.9.2', 'github').browser_download_url
            })
          ]
        })
      }
    })

    await expect(service.check()).resolves.toMatchObject({
      status: 'current',
      downloadAvailable: false,
      downloadUrl: null
    })
  })

  it('does not query release APIs on platforms whose downloads are paused', async () => {
    let requestCount = 0
    const service = new AppUpdateService({
      currentVersion: '0.9.2',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: async () => {
        requestCount += 1
        return jsonResponse({ tag_name: 'v0.9.2' })
      }
    })

    await expect(service.check()).resolves.toMatchObject({
      status: 'unsupported',
      latestVersion: null,
      downloadAvailable: false,
      error: '当前更新下载暂时只提供 Windows x64 安装包。'
    })
    expect(requestCount).toBe(0)
  })

  it('distinguishes no published Release from a network failure', async () => {
    const noRelease = new AppUpdateService({
      currentVersion: '0.9.2',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => jsonResponse({ message: 'Not Found' }, 404)
    })
    await expect(noRelease.check()).resolves.toMatchObject({
      status: 'unpublished',
      error: '当前还没有公开发布版本。首次 Release 发布后，这里会显示最新版本。'
    })

    const offline = new AppUpdateService({
      currentVersion: '0.9.2',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => {
        throw new Error('network unavailable')
      }
    })
    await expect(offline.check()).resolves.toMatchObject({
      status: 'error',
      error: '暂时无法连接更新服务，请稍后重试。'
    })
  })
})
