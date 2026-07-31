import os from 'os'

export function classifySystem(platform = process.platform, release = os.release()) {
  if (platform === 'darwin') return 'mac'
  if (platform !== 'win32') throw new Error(`不支持的远程服务平台: ${platform}`)
  const build = Number(String(release).split('.')[2] || 0)
  return build >= 22000 ? 'win11' : 'win10'
}

export async function collectDeviceInfo(app, installationId) {
  const cpus = os.cpus()
  let gpuModel = null
  try {
    const gpuInfo = await app.getGPUInfo('basic')
    const devices = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice : []
    const names = devices
      .map((device) => device?.deviceString || device?.vendorString)
      .filter(Boolean)
    if (names.length) gpuModel = [...new Set(names)].join(' / ')
  } catch (error) {
    console.warn('[remote] 获取 GPU 信息失败:', error)
  }

  return {
    installation_id: installationId,
    app_version: app.getVersion(),
    system_group: classifySystem(),
    system_version: os.version(),
    system_build: os.release(),
    system_arch: os.arch(),
    cpu_model: cpus[0]?.model?.trim() || null,
    cpu_arch: process.arch,
    cpu_cores: cpus.length || null,
    gpu_model: gpuModel,
    memory_total: os.totalmem(),
    locale: app.getLocale(),
    started_at: new Date().toISOString()
  }
}
