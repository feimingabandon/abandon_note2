// 展开保留舒展的减速段；收起略短。两者继续由同一原生合成曲线驱动。
export function compactMotionDuration(phase) {
  return phase === 'collapsing' ? 320 : 400
}
