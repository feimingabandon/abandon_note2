const FIXED_SOLAR_FESTIVALS = Object.freeze({
  '01-01': [{ name: '元旦', category: 'public-holiday', priority: 10 }],
  '01-10': [
    {
      name: '中国人民警察节',
      label: '警察节',
      category: 'national-observance',
      priority: 45,
      since: 2021
    }
  ],
  '02-07': [{ name: '二七纪念日', category: 'memorial', priority: 70 }],
  '02-14': [{ name: '情人节', category: 'common-modern', priority: 40 }],
  '03-08': [{ name: '妇女节', category: 'partial-holiday', priority: 30 }],
  '03-12': [{ name: '植树节', category: 'national-observance', priority: 45 }],
  '04-01': [{ name: '愚人节', category: 'common-modern', priority: 60 }],
  '04-15': [
    {
      name: '全民国家安全教育日',
      label: '国家安全日',
      category: 'national-observance',
      priority: 45,
      since: 2016
    }
  ],
  '05-01': [{ name: '劳动节', category: 'public-holiday', priority: 10 }],
  '05-04': [{ name: '青年节', category: 'partial-holiday', priority: 30 }],
  '05-12': [{ name: '国际护士节', label: '护士节', category: 'industry', priority: 50 }],
  '05-30': [{ name: '五卅纪念日', category: 'memorial', priority: 70 }],
  '06-01': [{ name: '儿童节', category: 'partial-holiday', priority: 30 }],
  '07-01': [
    { name: '中国共产党建党纪念日', label: '建党节', category: 'national-observance', priority: 45 }
  ],
  '07-07': [{ name: '七七抗战纪念日', category: 'memorial', priority: 70 }],
  '08-01': [
    {
      name: '中国人民解放军建军纪念日',
      label: '建军节',
      category: 'partial-holiday',
      priority: 30
    }
  ],
  '08-19': [
    { name: '中国医师节', label: '医师节', category: 'industry', priority: 50, since: 2018 }
  ],
  '09-03': [
    {
      name: '中国人民抗日战争胜利纪念日',
      label: '抗战胜利日',
      category: 'memorial',
      priority: 70
    }
  ],
  '09-10': [{ name: '教师节', category: 'industry', priority: 50, since: 1985 }],
  '09-18': [{ name: '九一八纪念日', category: 'memorial', priority: 70 }],
  '09-30': [{ name: '烈士纪念日', category: 'memorial', priority: 70, since: 2014 }],
  '10-01': [{ name: '国庆节', category: 'public-holiday', priority: 10 }],
  '10-31': [{ name: '万圣夜', category: 'common-modern', priority: 60 }],
  '11-08': [{ name: '记者节', category: 'industry', priority: 50, since: 2000 }],
  '12-04': [{ name: '国家宪法日', category: 'national-observance', priority: 45, since: 2014 }],
  '12-13': [
    {
      name: '南京大屠杀死难者国家公祭日',
      label: '国家公祭日',
      category: 'memorial',
      priority: 70,
      since: 2014
    }
  ],
  '12-24': [{ name: '平安夜', category: 'common-modern', priority: 60 }],
  '12-25': [{ name: '圣诞节', category: 'common-modern', priority: 60 }]
})

const LUNAR_FESTIVALS = Object.freeze({
  '1-1': [{ name: '春节', category: 'traditional', priority: 10, isPublicHoliday: true }],
  '1-5': [{ name: '破五节', label: '破五', category: 'traditional', priority: 25 }],
  '1-7': [{ name: '人日节', label: '人日', category: 'traditional', priority: 25 }],
  '1-15': [{ name: '元宵节', label: '元宵', category: 'traditional', priority: 20 }],
  '1-25': [{ name: '填仓节', label: '填仓', category: 'traditional', priority: 25 }],
  '2-2': [{ name: '龙抬头', category: 'traditional', priority: 20 }],
  '2-12': [{ name: '花朝节', label: '花朝', category: 'traditional', priority: 25 }],
  '3-3': [{ name: '上巳节', label: '上巳', category: 'traditional', priority: 20 }],
  '4-8': [{ name: '浴佛节', label: '浴佛', category: 'traditional', priority: 25 }],
  '5-5': [
    {
      name: '端午节',
      label: '端午',
      category: 'traditional',
      priority: 10,
      isPublicHoliday: true
    }
  ],
  '6-6': [{ name: '天贶节（晒衣节）', label: '晒衣节', category: 'traditional', priority: 25 }],
  '7-7': [{ name: '七夕节', label: '七夕', category: 'traditional', priority: 20 }],
  '7-15': [{ name: '中元节', label: '中元', category: 'traditional', priority: 20 }],
  '8-15': [
    {
      name: '中秋节',
      label: '中秋',
      category: 'traditional',
      priority: 10,
      isPublicHoliday: true
    }
  ],
  '9-9': [{ name: '重阳节', label: '重阳', category: 'traditional', priority: 20 }],
  '10-1': [{ name: '寒衣节', label: '寒衣', category: 'traditional', priority: 20 }],
  '10-15': [{ name: '下元节', label: '下元', category: 'traditional', priority: 20 }],
  '12-8': [{ name: '腊八节', label: '腊八', category: 'traditional', priority: 20 }],
  '12-23': [{ name: '小年（北方）', label: '北方小年', category: 'traditional', priority: 20 }],
  '12-24': [{ name: '小年（南方）', label: '南方小年', category: 'traditional', priority: 20 }]
})

const FLOATING_SOLAR_FESTIVALS = Object.freeze([
  {
    name: '母亲节',
    category: 'family',
    priority: 40,
    month: 5,
    weekday: 0,
    occurrence: 2
  },
  {
    name: '父亲节',
    category: 'family',
    priority: 40,
    month: 6,
    weekday: 0,
    occurrence: 3
  },
  {
    name: '感恩节',
    category: 'common-modern',
    priority: 60,
    month: 11,
    weekday: 4,
    occurrence: 4
  }
])

function parseDateKey(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number)
  return { year, month, day }
}

function nthWeekdayOfMonth(year, month, weekday, occurrence) {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  return 1 + ((weekday - firstWeekday + 7) % 7) + (occurrence - 1) * 7
}

// Meeus/Jones/Butcher Gregorian computus, valid for Gregorian calendar years.
function gregorianEasterDate(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return { month, day }
}

function definitionApplies(definition, year) {
  return (
    (!definition.since || year >= definition.since) &&
    (!definition.until || year <= definition.until)
  )
}

function publicFestival(definition) {
  return {
    name: definition.name,
    label: definition.label || definition.name,
    category: definition.category,
    isPublicHoliday: definition.isPublicHoliday === true || definition.category === 'public-holiday'
  }
}

/** 返回适合中国大陆月历展示的常见传统、国家纪念及现代节日。 */
export function calendarFestivalsForDate({
  dateKey,
  lunar,
  solarTerm = null,
  isColdFoodDay = false
}) {
  const { year, month, day } = parseDateKey(dateKey)
  const definitions = []
  const fixedKey = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  definitions.push(
    ...(FIXED_SOLAR_FESTIVALS[fixedKey] || []).filter((item) => definitionApplies(item, year))
  )

  for (const definition of FLOATING_SOLAR_FESTIVALS) {
    if (
      month === definition.month &&
      day === nthWeekdayOfMonth(year, definition.month, definition.weekday, definition.occurrence)
    ) {
      definitions.push(definition)
    }
  }

  const easter = gregorianEasterDate(year)
  if (month === easter.month && day === easter.day) {
    definitions.push({ name: '复活节', category: 'common-modern', priority: 60 })
  }

  if (solarTerm === '秋分' && year >= 2018) {
    definitions.push({
      name: '中国农民丰收节',
      label: '丰收节',
      category: 'national-observance',
      priority: 45
    })
  }
  if (solarTerm === '清明') {
    definitions.push({
      name: '清明节',
      label: '清明',
      category: 'traditional',
      priority: 10,
      isPublicHoliday: true
    })
  }
  if (solarTerm === '冬至') {
    definitions.push({ name: '冬至节', label: '冬至', category: 'traditional', priority: 20 })
  }
  if (isColdFoodDay) {
    definitions.push({ name: '寒食节', label: '寒食', category: 'traditional', priority: 20 })
  }

  if (lunar && !lunar.isLeap) {
    definitions.push(...(LUNAR_FESTIVALS[`${lunar.lunarMon}-${lunar.lunarDay}`] || []))
    if (lunar.lunarMon === 12 && lunar.lunarDay === lunar.daysInMonth) {
      definitions.push({
        name: '除夕',
        category: 'traditional',
        priority: 10,
        isPublicHoliday: true
      })
    }
  }

  const unique = new Map()
  definitions
    .map((definition, index) => ({ ...definition, index }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .forEach((definition) => {
      if (!unique.has(definition.name)) unique.set(definition.name, publicFestival(definition))
    })
  return [...unique.values()]
}
