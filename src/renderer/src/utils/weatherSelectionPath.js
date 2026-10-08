/** Restore only a real saved path; never preselect an unrelated district. */
export function weatherSelectionPath(options, location) {
  if (!location || (location.countryCode && location.countryCode !== 'CN')) return []
  const normalize = (name) => String(name || '').replace(/(?:省|市|自治区|特别行政区)$/u, '')
  const findId = (nodes, parents = []) => {
    for (const node of nodes) {
      const path = [...parents, node.code]
      if (location.id && String(node.candidate?.id) === String(location.id)) return path
      const nested = findId(node.children || [], path)
      if (nested.length) return nested
    }
    return []
  }
  const exact = findId(options)
  if (exact.length) return exact
  const province = options.find(
    (node) => normalize(node.name) === normalize(location.admin1 || location.name)
  )
  if (!province) return []
  const city = province.children?.find(
    (node) => normalize(node.name) === normalize(location.admin2 || location.name)
  )
  if (!city) return [province.code]
  const district = city.children?.find((node) => node.name === location.name)
  return [province.code, city.code, ...(district ? [district.code] : [])]
}
