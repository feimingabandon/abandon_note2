const { contextBridge, ipcRenderer } = require('electron')

const sessionId = process.argv.find((value) => value.startsWith('--prototype-session='))?.slice(20)
if (!sessionId) throw new Error('Missing isolated draft prototype session')
const leases = new Map()
const invoke = async (action, payload = {}) => {
  const response = await ipcRenderer.invoke('draft-prototype:invoke', { action, ...payload })
  if (!response.ok) {
    const error = new Error(response.error.message)
    error.code = response.error.code
    throw error
  }
  return response.value
}
function privateLease(owner) {
  const lease = leases.get(owner?.ownerId)
  if (
    !lease ||
    owner.sessionId !== lease.sessionId ||
    owner.generation !== lease.generation ||
    owner.key !== lease.key
  ) {
    const error = new Error('Unknown document owner metadata')
    error.code = 'DRAFT_LEASE_INVALID'
    throw error
  }
  return lease
}

contextBridge.exposeInMainWorld('api', {
  runtimeCapabilities: { editingDraftSessionId: sessionId }
})
contextBridge.exposeInMainWorld('draftApi', {
  async openOwner(key, resume = null) {
    const lease = await invoke('open', { key, resume })
    leases.set(lease.ownerId, { ...lease, key })
    return { sessionId: lease.sessionId, key, ownerId: lease.ownerId, generation: lease.generation }
  },
  stage: (owner, image) => invoke('stage', { lease: privateLease(owner), image }),
  async preview(owner, assetId) {
    const result = await invoke('preview', { lease: privateLease(owner), assetId })
    return { ...result, bytes: new Uint8Array(result.bytes) }
  },
  release: (owner, assetIds) => invoke('release', { lease: privateLease(owner), assetIds }),
  cancelOwner: (owner) => invoke('cancel', { lease: privateLease(owner) }),
  beginHandoff: (owner, assetIds) => invoke('handoff', { lease: privateLease(owner), assetIds }),
  waitHandoff: (owner, operationId) => invoke('wait', { lease: privateLease(owner), operationId }),
  operationState: (owner, operationId) =>
    invoke('operation', { lease: privateLease(owner), operationId }),
  // Test-only, fixed negative probes cross the real IPC boundary with the private
  // capability retained here. No generic channel or capability export is exposed.
  invalidLeaseProbe(owner, field, assetId) {
    if (!['sessionId', 'ownerId', 'generation', 'capability'].includes(field))
      throw new Error('Unsupported negative lease probe')
    const lease = { ...privateLease(owner) }
    lease[field] = field === 'generation' ? Number(lease[field]) + 1 : 'invalid-prototype-' + field
    // contextBridge does not promise preservation of custom Error fields. Return
    // the main failure metadata as ordinary structured data for these probes.
    return ipcRenderer
      .invoke('draft-prototype:invoke', { action: 'preview', lease, assetId })
      .then((response) => (response.ok ? { ok: true } : response.error))
  },
  invalidResumeProbe(key, resume) {
    return ipcRenderer
      .invoke('draft-prototype:invoke', { action: 'open', key, resume })
      .then((response) => (response.ok ? { ok: true } : response.error))
  }
})
