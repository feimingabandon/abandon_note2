import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDbIfInitialized } from '../../src/main/db/db-connection.js'
import {
  buildDailyReportExcel,
  buildDailyReportText
} from '../../src/main/services/daily-report.js'

// ZIP is supplied by the pinned ExcelJS dependency which writes this container.
// We read raw XML numbers here, independently of ExcelJS's Date deserializer.
const require = createRequire(import.meta.url)
const excelRequire = createRequire(require.resolve('exceljs/package.json'))
const JSZip = excelRequire('jszip')
const expectedByZone = {
  'Asia/Shanghai': {
    offset: -480,
    cells: {
      E2: 46314.375,
      F2: 46314,
      H2: 46314 + 632 / 1440,
      E3: 46315 + 5 / 1440,
      F3: 46316,
      E4: 46327 + 810 / 1440,
      F4: 46327,
      H4: 46327 + 870 / 1440
    },
    text: ['2026-10-19 10:32', '2026-10-20 00:05', '2026-11-01 14:30']
  },
  UTC: {
    offset: 0,
    cells: {
      E2: 46314 + 60 / 1440,
      F2: 46314,
      H2: 46314 + 152 / 1440,
      E3: 46314 + 965 / 1440,
      F3: 46315,
      E4: 46327 + 330 / 1440,
      F4: 46327,
      H4: 46327 + 390 / 1440
    },
    text: ['2026-10-19 02:32', '2026-10-19 16:05', '2026-11-01 06:30']
  },
  'America/New_York': {
    offset: 240,
    cells: {
      E2: 46313 + 1260 / 1440,
      F2: 46313,
      H2: 46313 + 1352 / 1440,
      E3: 46314 + 725 / 1440,
      F3: 46315,
      E4: 46327 + 90 / 1440,
      F4: 46327,
      H4: 46327 + 90 / 1440
    },
    text: ['2026-10-18 22:32', '2026-10-19 12:05', '2026-11-01 01:30']
  }
}
const zone = process.env.TZ
const expected = expectedByZone[zone]
assert.ok(expected, 'A named isolated test timezone is required')
const output = resolve(process.argv[2])
mkdirSync(output, { recursive: true })
const write = (name, value) => writeFileSync(join(output, name), value, { flag: 'wx' })
const notes = [
  {
    id: 1,
    status: 'completed',
    content: '=literal text',
    is_pinned: 1,
    effective_at: Date.parse('2026-10-19T01:00:00Z'),
    finished_at: Date.parse('2026-10-19T02:32:00Z'),
    duration_kind: 'single_day',
    duration_days: 1,
    tags: [{ name: 'local-time' }]
  },
  {
    id: 2,
    status: 'in_progress',
    content: 'Midnight and two natural dates',
    is_pinned: 0,
    effective_at: Date.parse('2026-10-19T16:05:00Z'),
    duration_kind: 'fixed_days',
    duration_days: 2,
    tags: []
  },
  {
    id: 3,
    status: 'completed',
    content: 'DST repeated local hour',
    is_pinned: 0,
    effective_at: Date.parse('2026-11-01T05:30:00Z'),
    finished_at: Date.parse('2026-11-01T06:30:00Z'),
    duration_kind: 'single_day',
    duration_days: 1,
    tags: []
  }
]
const options = { startDateKey: '2026-10-18', endDateKey: '2026-11-01', notes }
const { buffer, truncatedCount } = await buildDailyReportExcel(options)
const text = buildDailyReportText(options)
write('report.xlsx', buffer)
write('report.txt', text)
const zip = await JSZip.loadAsync(buffer)
const [worksheet, styles, workbook] = await Promise.all(
  ['xl/worksheets/sheet1.xml', 'xl/styles.xml', 'xl/workbook.xml'].map((name) =>
    zip.file(name).async('string')
  )
)
write('worksheet.xml', worksheet)
write('styles.xml', styles)
write('workbook.xml', workbook)
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
const readCells = (xml) =>
  new Map(
    [...xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((match) => [
      attribute(match[1], 'r'),
      {
        type: attribute(match[1], 't') ?? 'n',
        style: Number(attribute(match[1], 's') ?? 0),
        raw: (match[2] ?? '').match(/<v>([^<]*)<\/v>/)?.[1] ?? null
      }
    ])
  )
const cells = readCells(worksheet)
function readFormats(xml) {
  const formats = new Map(
    [...xml.matchAll(/<numFmt\b([^>]*)\/?\s*>/g)].map((match) => [
      Number(attribute(match[1], 'numFmtId')),
      attribute(match[1], 'formatCode')
    ])
  )
  const cellXfs = [
    ...(xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '').matchAll(/<xf\b([^>]*)>/g)
  ].map((match) => Number(attribute(match[1], 'numFmtId')))
  return (cell) => formats.get(cellXfs[cell?.style])
}
const formatFor = readFormats(styles)
const observations = Object.entries(expected.cells).map(([reference, value]) => {
  const cell = cells.get(reference)
  const actual = cell?.raw === null ? null : Number(cell?.raw)
  const format = formatFor(cell)
  const expectedFormat = reference.startsWith('F') ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm'
  return {
    reference,
    expected: value,
    actual,
    raw: cell?.raw,
    type: cell?.type,
    format,
    expectedFormat,
    matches:
      cell?.type === 'n' &&
      Number.isFinite(actual) &&
      Math.abs(actual - value) < 1e-9 &&
      format === expectedFormat
  }
})
// Excel's 1900 system contains an imaginary February 29. These supported date
// keys must use serials 1/59/61, which same-library Date readback can conceal.
const earlyDates = [
  [1900, 1, 1, 1],
  [1900, 2, 28, 59],
  [1900, 3, 1, 61]
]
const early = await buildDailyReportExcel({
  startDateKey: '1900-01-01',
  endDateKey: '1900-03-01',
  notes: earlyDates.map(([year, month, day], index) => ({
    id: index + 10,
    status: 'in_progress',
    content: 'Supported early calendar date',
    effective_at: new Date(year, month - 1, day, 12).getTime(),
    duration_kind: 'single_day',
    duration_days: 1,
    tags: []
  }))
})
write('early-dates.xlsx', early.buffer)
const earlyZip = await JSZip.loadAsync(early.buffer)
const earlyXml = await earlyZip.file('xl/worksheets/sheet1.xml').async('string')
const earlyStyles = await earlyZip.file('xl/styles.xml').async('string')
const earlyWorkbook = await earlyZip.file('xl/workbook.xml').async('string')
write('early-worksheet.xml', earlyXml)
write('early-styles.xml', earlyStyles)
write('early-workbook.xml', earlyWorkbook)
const earlyCells = readCells(earlyXml)
const earlyFormatFor = readFormats(earlyStyles)
const earlyDateObservations = earlyDates.map(([year, month, day, serial], index) => {
  const reference = 'F' + (index + 2)
  const cell = earlyCells.get(reference)
  const actual = Number(cell?.raw)
  const format = earlyFormatFor(cell)
  return {
    reference,
    year,
    month,
    day,
    expected: serial,
    actual,
    format,
    timestampBlank: earlyCells.get('E' + (index + 2))?.raw == null,
    matches: cell?.type === 'n' && actual === serial && format === 'yyyy-mm-dd'
  }
})
// A valid source instant can overflow Date when its local fields are used as
// a UTC carrier. Keep that cell blank rather than serializing NaN.
const maxTimestamp = 8_640_000_000_000_000
const maxDate = new Date(maxTimestamp)
const maxCarrier = new Date(
  Date.UTC(
    maxDate.getFullYear(),
    maxDate.getMonth(),
    maxDate.getDate(),
    maxDate.getHours(),
    maxDate.getMinutes(),
    maxDate.getSeconds(),
    maxDate.getMilliseconds()
  )
)
const overflow = await buildDailyReportExcel({
  dateKey: '2026-10-19',
  notes: [{ ...notes[0], finished_at: maxTimestamp }]
})
write('carrier-overflow.xlsx', overflow.buffer)
const overflowZip = await JSZip.loadAsync(overflow.buffer)
const overflowXml = await overflowZip.file('xl/worksheets/sheet1.xml').async('string')
write('carrier-overflow-worksheet.xml', overflowXml)
const maxRaw = readCells(overflowXml).get('H2')?.raw ?? null
const maxCompletionObservation = {
  originalTimestamp: maxTimestamp,
  originalDateValid: Number.isFinite(maxDate.getTime()),
  carrierValid: Number.isFinite(maxCarrier.getTime()),
  blank: maxRaw === null,
  raw: maxRaw,
  finiteNumeric: maxRaw !== null && Number.isFinite(Number(maxRaw))
}
maxCompletionObservation.matches =
  maxCompletionObservation.originalDateValid &&
  (zone === 'Asia/Shanghai'
    ? !maxCompletionObservation.carrierValid && maxCompletionObservation.blank
    : maxCompletionObservation.carrierValid &&
      !maxCompletionObservation.blank &&
      maxCompletionObservation.finiteNumeric)
const offset = new Date(notes[0].effective_at).getTimezoneOffset()
const failures = []
if (getDbIfInitialized() !== null)
  failures.push('Date serialization must not open the application database')
if (offset !== expected.offset) failures.push('Child process timezone was not applied')
if (!maxCompletionObservation.matches)
  failures.push('Valid source timestamp with overflowing local carrier must remain blank')
if (/<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(workbook))
  failures.push('Unexpected 1904 date system')
if (truncatedCount !== 0) failures.push('Unexpected truncation')
if ([...worksheet.matchAll(/<row\b/g)].length !== 4)
  failures.push('Expected header and three note rows')
if (cells.get('H3')?.raw != null)
  failures.push('Incomplete note must have a blank finish timestamp')
for (const value of expected.text)
  if (!text.includes(value)) failures.push('TXT missing local wall time: ' + value)
if (
  zone === 'America/New_York' &&
  (new Date(notes[2].effective_at).getTimezoneOffset() !== 240 ||
    new Date(notes[2].finished_at).getTimezoneOffset() !== 300)
)
  failures.push('DST test must cross the actual offset change')
for (const cell of observations)
  if (!cell.matches) failures.push('Incorrect numeric Excel cell: ' + cell.reference)
if (/<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(earlyWorkbook))
  failures.push('Unexpected early-date 1904 date system')
for (const cell of earlyDateObservations) {
  if (!cell.matches) failures.push('Incorrect early-1900 Excel cell: ' + cell.reference)
  if (!cell.timestampBlank) failures.push('Legacy nonpositive timestamp policy must remain blank')
}
const service = fileURLToPath(new URL('../../src/main/services/daily-report.js', import.meta.url))
const result = {
  timezone: zone,
  offsetMinutes: offset,
  completed: failures.length === 0,
  failures,
  observations,
  earlyDateObservations,
  maxCompletionObservation,
  truncatedCount,
  databaseOpened: getDbIfInitialized() !== null,
  sourceSha256: createHash('sha256').update(readFileSync(service)).digest('hex'),
  xlsxSha256: createHash('sha256').update(buffer).digest('hex'),
  containerReader: {
    owner: 'exceljs',
    dependency: 'jszip',
    version: excelRequire('jszip/package.json').version,
    purpose: 'ZIP container only; no ExcelJS Date readback'
  }
}
write('result.json', JSON.stringify(result, null, 2))
process.stdout.write(JSON.stringify(result) + '\n')
process.exitCode = result.completed ? 0 : 1
