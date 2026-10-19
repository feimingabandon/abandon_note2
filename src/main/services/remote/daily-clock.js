const DAY_MS = 24 * 60 * 60 * 1000

export function chinaDate(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function nextChinaDayDelay(now = Date.now(), random = Math.random) {
  const shifted = now + 8 * 60 * 60 * 1000
  return DAY_MS - (shifted % DAY_MS) + 30_000 + Math.floor(random() * 270_000)
}
