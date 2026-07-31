const DEFAULT_TIMEOUT_MS = 3000

function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
}

async function requestJson(url, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const startedAt = Date.now()
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } catch (error) {
    console.warn(`[remote] 请求失败: ${method} ${url} (${Date.now() - startedAt}ms):`, error)
    throw error
  }
}

export class RemoteClient {
  constructor(baseUrl) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
  }

  get configured() {
    return Boolean(this.baseUrl)
  }

  health() {
    return requestJson(`${this.baseUrl}/health`)
  }

  startSession(payload) {
    return requestJson(`${this.baseUrl}/session/start`, { method: 'POST', body: payload })
  }

  endSession(sessionId) {
    return requestJson(`${this.baseUrl}/session/end`, {
      method: 'POST',
      timeoutMs: 1200,
      body: { session_id: sessionId, ended_at: new Date().toISOString() }
    })
  }

  pullNotices(payload) {
    return requestJson(`${this.baseUrl}/notices/pull`, { method: 'POST', body: payload })
  }
}
