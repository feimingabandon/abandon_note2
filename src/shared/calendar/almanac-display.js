const priority = [
  '嫁娶',
  '结婚姻',
  '搬移',
  '入宅',
  '出行',
  '开市',
  '立券交易',
  '修造',
  '祭祀',
  '祈福',
  '沐浴',
  '扫舍宇'
]
export const ALMANAC_GLOSSARY = Object.freeze({
  嫁娶: '结婚',
  结婚姻: '议婚、订立婚约',
  入宅: '迁入新居',
  搬移: '迁居',
  移徙: '迁居',
  开市: '开业、开张',
  立券交易: '订立契约与交易',
  修造: '修建房屋',
  纳采: '传统婚俗中的提亲礼',
  沐浴: '清洁身体',
  扫舍宇: '清扫房屋',
  破屋坏垣: '拆除破旧房屋或围墙',
  启攒: '迁葬前启墓'
})
export function almanacSummary(group, emptyLabel, limit = 3) {
  if (group?.special?.length) return group.special.join('、')
  const items = [...(group?.items || [])]
  const rank = (value) => (priority.includes(value) ? priority.indexOf(value) : priority.length)
  items.sort((a, b) => rank(a) - rank(b))
  return items.length
    ? `${items.slice(0, limit).join('、')}${items.length > limit ? '…' : ''}`
    : emptyLabel
}
