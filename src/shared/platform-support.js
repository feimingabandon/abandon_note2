export function getWindowsPlatformCompatibility(platform = process.platform) {
  return {
    success: platform === 'win32',
    required: true,
    platform,
    error:
      platform === 'win32'
        ? null
        : { code: 'UNSUPPORTED_PLATFORM', message: 'Abandon Note 仅支持 Windows 10/11。' }
  }
}

/** Refuse unsupported hosts before opening data or loading the application. */
export function enforceWindowsPlatform({ platform = process.platform, report, exit }) {
  const compatibility = getWindowsPlatformCompatibility(platform)
  if (compatibility.success) return true
  try {
    report(compatibility.error)
  } finally {
    exit(1)
  }
  return false
}
