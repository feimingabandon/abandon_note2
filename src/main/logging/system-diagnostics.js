import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

async function readWindowsVersion() {
  if (process.platform !== 'win32') return null
  const { stdout } = await execFileAsync(
    join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' | Select-Object ProductName,DisplayVersion,CurrentBuildNumber,UBR,EditionID | ConvertTo-Json -Compress"
    ],
    { windowsHide: true, timeout: 3000, maxBuffer: 32 * 1024 }
  )
  return JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
}

function pick(object, keys) {
  return Object.fromEntries(
    keys.filter((key) => object?.[key] !== undefined).map((key) => [key, object[key]])
  )
}

// 每次导出重新采集；任何单项失败/超时只留下说明，不阻断已有日志的导出。
// 不采集用户名、机器序列号、产品密钥、网络地址或便签内容。
export async function collectSystemDiagnostics(
  { app, screen, windows = [], runtime = {} },
  overrides = {}
) {
  const errors = []
  const attempt = async (name, callback, timeoutMs = 3500) => {
    let timer
    try {
      return await Promise.race([
        Promise.resolve().then(callback),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('collection timed out')), timeoutMs)
        })
      ])
    } catch (error) {
      errors.push({ field: name, message: String(error?.message || error).slice(0, 300) })
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  const [windowsVersion, gpu, bundleHash, nativeHash] = await Promise.all([
    attempt('windowsVersion', overrides.readWindowsVersion || readWindowsVersion),
    attempt('gpu', () => app.getGPUInfo('complete')),
    attempt('mainBundleSha256', async () =>
      createHash('sha256')
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest('hex')
    ),
    attempt('nativeDllSha256', async () =>
      runtime.native?.dllPath
        ? createHash('sha256')
            .update(await readFile(runtime.native.dllPath))
            .digest('hex')
        : null
    )
  ])
  return {
    capturedAt: new Date().toISOString(),
    application: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      arch: process.arch,
      versions: process.versions,
      mainBundleSha256: bundleHash,
      nativeDllSha256: nativeHash
    },
    system: {
      platform: process.platform,
      release: os.release(),
      version: os.version(),
      arch: os.arch(),
      windowsVersion,
      uptimeSeconds: os.uptime(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    hardware: {
      cpuModel: os.cpus()[0]?.model || null,
      logicalProcessors: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem()
    },
    graphics: {
      devices:
        gpu?.gpuDevice?.map((device) =>
          pick(device, [
            'vendorId',
            'deviceId',
            'active',
            'vendorString',
            'deviceString',
            'driverVendor',
            'driverVersion',
            'driverDate'
          ])
        ) || null,
      auxiliary: pick(gpu?.auxAttributes, [
        'glVendor',
        'glRenderer',
        'glVersion',
        'inProcessGpu',
        'sandboxed',
        'optimus',
        'amdSwitchable',
        'passthroughCmdDecoder'
      ]),
      featureStatus: await attempt('gpuFeatureStatus', () => app.getGPUFeatureStatus())
    },
    displays: await attempt('displays', () => {
      const primaryId = screen.getPrimaryDisplay().id
      return screen.getAllDisplays().map((display) => ({
        ...pick(display, [
          'id',
          'label',
          'bounds',
          'workArea',
          'size',
          'workAreaSize',
          'scaleFactor',
          'rotation',
          'displayFrequency',
          'colorDepth',
          'depthPerComponent',
          'internal',
          'touchSupport'
        ]),
        primary: display.id === primaryId,
        scalePercent: display.scaleFactor * 100
      }))
    }),
    windows: await attempt('windows', () =>
      windows
        .filter((window) => !window.isDestroyed())
        .map((window) => ({
          id: window.id,
          bounds: window.getBounds(),
          contentBounds: window.getContentBounds(),
          visible: window.isVisible(),
          minimized: window.isMinimized(),
          maximized: window.isMaximized(),
          focused: window.isFocused(),
          alwaysOnTop: window.isAlwaysOnTop(),
          opacity: window.getOpacity(),
          zoomFactor: window.webContents.getZoomFactor(),
          rendererPid: window.webContents.getOSProcessId()
        }))
    ),
    processes: await attempt('processes', () =>
      app.getAppMetrics().map((metric) => pick(metric, ['pid', 'type', 'cpu', 'memory']))
    ),
    runtime,
    collectionErrors: errors
  }
}
