/** 页面准备与原生运动重叠；任一失败也必须等两边结束后才允许清理或回滚 HWND。 */
export async function settleCompactPresentation(nativeTransition, prepareTarget) {
  const results = await Promise.allSettled([
    nativeTransition,
    Promise.resolve().then(prepareTarget)
  ])
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason
  }
  return results[0].value
}
