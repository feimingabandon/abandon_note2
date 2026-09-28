// Wrapper tests inject a synchronous sink; the real batched transport has its own tests.
export const deepPolicy = () => ({
  mode: 'deep',
  policyEpoch: 1,
  expiresAt: Date.now() + 600000,
  sampleIntervalMs: 5000
})
export const diagnosticTransportFixture = (raw) => ({
  report: (payload) => raw.send('logs:write', payload),
  getPolicy: deepPolicy,
  flush: async () => ({ incomplete: false })
})
