// Calendar data types + helpers for the home-page CalendarWidget.
//
// The payload at `<base>/data/calendar.json` is built offline by
// `pipeline/build_calendar.py` from the academic-dates + holidays
// scrapers under `scraper/output/`. It is intentionally separate from the RAG corpus
// (`chunks.json`) — date-keyed facts shouldn't be retrievable by
// semantic search.

export type CalendarCategory = 'academic' | 'holiday'

export interface CalendarItem {
  id: string
  category: CalendarCategory
  title: string
  date: string // 'YYYY-MM-DD'
  endDate?: string
  url?: string
  description?: string
}

export interface CalendarPayload {
  generatedAt: string
  items: CalendarItem[]
}

export async function loadCalendar(): Promise<CalendarPayload> {
  const url = `${import.meta.env.BASE_URL}data/calendar.json`
  const res = await fetch(url, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`calendar.json: HTTP ${res.status}`)
  return (await res.json()) as CalendarPayload
}

// --- Date helpers (no external dep) ---

// Parse 'YYYY-MM-DD' as a *local* date. Avoid `new Date('YYYY-MM-DD')`
// because that parses as UTC and shifts by one day in negative-offset
// timezones.
export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map((s) => Number(s))
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

// 6x7 calendar grid starting on Sunday, including spillover days from
// the previous and next month so every cell is a real Date.
export function buildMonthGrid(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1)
  // Sunday = 0; back up to the most recent Sunday.
  const start = new Date(first)
  start.setDate(first.getDate() - first.getDay())
  const weeks: Date[][] = []
  const cur = new Date(start)
  for (let w = 0; w < 6; w++) {
    const row: Date[] = []
    for (let d = 0; d < 7; d++) {
      row.push(new Date(cur))
      cur.setDate(cur.getDate() + 1)
    }
    weeks.push(row)
  }
  return weeks
}

// Returns true if a calendar item covers a given local date (inclusive
// of `endDate` when present).
export function itemCoversDate(item: CalendarItem, date: Date): boolean {
  const target = toISODate(date)
  if (!item.endDate) return target === item.date
  return target >= item.date && target <= item.endDate
}

const MONTH_NAME = new Intl.DateTimeFormat('en-CA', { month: 'long' })
const MONTH_SHORT = new Intl.DateTimeFormat('en-CA', { month: 'short' })
const FULL_DATE = new Intl.DateTimeFormat('en-CA', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})

// Year first, then month name — explicit concat so the order doesn't
// depend on the locale's default month/year ordering.
export function formatMonthHeading(d: Date): string {
  return `${d.getFullYear()} ${MONTH_NAME.format(d)}`
}

export function formatMonthBadge(d: Date): string {
  return MONTH_SHORT.format(d).toUpperCase()
}

export function formatFullDate(d: Date): string {
  return FULL_DATE.format(d)
}
