import { DOCK_REVEAL_HANDLE_MODES } from '../../shared/settings-schema.js'

export const DOCK_EDGE_ORDER = Object.freeze(['top', 'left', 'right'])

const VALID_REVEAL_HANDLE_MODES = new Set(Object.values(DOCK_REVEAL_HANDLE_MODES))

function normalizeRevealHandleMode(value) {
  return VALID_REVEAL_HANDLE_MODES.has(value) ? value : DOCK_REVEAL_HANDLE_MODES.DIRECT
}

function canonicalDockEdges(edges) {
  const requested = new Set(Array.isArray(edges) ? edges : [])
  return DOCK_EDGE_ORDER.filter((side) => requested.has(side))
}

/**
 * 窗口 profile 表达能力上限，设置只能在该上限内继续缩小范围。
 * 两者都采用固定顺序，避免数据库 JSON 顺序影响边角处的选择。
 */
export function resolveActiveDockEdges(supportedEdges, enabledEdges) {
  const supported = new Set(canonicalDockEdges(supportedEdges))
  return canonicalDockEdges(enabledEdges).filter((side) => supported.has(side))
}

export function normalizeDockRuntimeConfig(config, supportedEdges) {
  const supported = canonicalDockEdges(supportedEdges)
  const enabledEdges = canonicalDockEdges(config?.enabledEdges)
  return {
    revealHandleMode: normalizeRevealHandleMode(config?.revealHandleMode),
    supportedEdges,
    enabledEdges,
    activeEdges: resolveActiveDockEdges(supported, enabledEdges)
  }
}

export function dockRuntimeConfigEqual(first, second) {
  if (
    normalizeRevealHandleMode(first?.revealHandleMode) !==
    normalizeRevealHandleMode(second?.revealHandleMode)
  ) {
    return false
  }
  const firstEdges = canonicalDockEdges(first?.enabledEdges)
  const secondEdges = canonicalDockEdges(second?.enabledEdges)
  return (
    firstEdges.length === secondEdges.length &&
    firstEdges.every((side, index) => side === secondEdges[index])
  )
}

/**
 * 原子 dock IPC 的输入校验。空数组是合法的，表示关闭所有贴边方向。
 */
export function validateDockConfigPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('贴边隐藏配置必须是对象')
  }
  const keys = Object.keys(payload)
  if (
    keys.length !== 2 ||
    !keys.every((key) => key === 'revealHandleMode' || key === 'enabledEdges')
  ) {
    throw new TypeError('贴边隐藏配置只能包含 revealHandleMode 和 enabledEdges')
  }
  if (!VALID_REVEAL_HANDLE_MODES.has(payload.revealHandleMode)) {
    throw new TypeError('小黑条模式只能是 direct、on-touch 或 persistent')
  }
  if (!Array.isArray(payload.enabledEdges)) {
    throw new TypeError('贴边方向必须是数组')
  }
  if (payload.enabledEdges.length > 12) {
    throw new TypeError('贴边方向载荷最多包含十二项')
  }
  if (payload.enabledEdges.some((side) => !DOCK_EDGE_ORDER.includes(side))) {
    throw new TypeError('贴边方向只能包含 top、left 或 right')
  }
  return {
    revealHandleMode: payload.revealHandleMode,
    enabledEdges: canonicalDockEdges(payload.enabledEdges)
  }
}

function offsetFromEdge(bounds, workArea, side) {
  if (side === 'left') return bounds.x - workArea.x
  if (side === 'right') {
    return workArea.x + workArea.width - (bounds.x + bounds.width)
  }
  return bounds.y - workArea.y
}

/**
 * offset 为正表示窗口仍在工作区内，为负表示已经越过屏幕边缘。贴边资格只
 * 限制内侧距离，避免用户把窗口拖出超过阈值后反而失去吸附和隐藏资格。
 * 多条边同时符合时仍按到边界线的绝对距离排序；完全等距时固定使用
 * top -> left -> right 的顺序，保证移动事件重放和高 DPI 场景可重现。
 */
export function selectNearestDockSide({ bounds, workArea, activeEdges, threshold, isExposed }) {
  if (!bounds || !workArea || !Number.isFinite(threshold) || threshold < 0) return null
  const candidates = resolveActiveDockEdges(DOCK_EDGE_ORDER, activeEdges)
    .map((side) => {
      const offset = offsetFromEdge(bounds, workArea, side)
      return { side, offset, distance: Math.abs(offset) }
    })
    .filter(({ side, offset }) => offset <= threshold && isExposed(side))
    .sort(
      (first, second) =>
        first.distance - second.distance ||
        DOCK_EDGE_ORDER.indexOf(first.side) - DOCK_EDGE_ORDER.indexOf(second.side)
    )
  return candidates[0]?.side || null
}

/**
 * 原生消息可能晚于 disarm 到达 JS 队列；只有代次与方向同时匹配当前
 * 冻结会话才允许改变窗口状态。
 */
export function isCurrentDockMonitorEvent(event, session) {
  return Boolean(
    event && session && event.generation === session.generation && event.side === session.side
  )
}
