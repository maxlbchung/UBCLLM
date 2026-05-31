import { useEffect, useMemo, useRef, useState } from 'react'
import { playSfx } from '../lib/sfx'
import {
  addMonths,
  buildMonthGrid,
  formatFullDate,
  formatMonthHeading,
  isSameDay,
  itemCoversDate,
  loadCalendar,
  startOfMonth,
  toISODate,
  type CalendarCategory,
  type CalendarItem,
} from '../lib/calendar'
import { ChevronDownIcon } from './icons'

// Per-category color tokens. Academic (course deadlines) steps outside the
// existing palette (purple) for visual separation — applied via an
// arbitrary Tailwind class so we don't have to widen `index.css`. Holiday
// stays on `bg-highlight` (amber) to ride the existing theme.
const CATEGORY_DOT: Record<CalendarCategory, string> = {
  academic: 'bg-[#a855f7]', // tailwind purple-500
  holiday: 'bg-highlight',
}

// Weekday column headers — single letter on narrow screens, three letters
// once there's room.
const WEEKDAYS_1 = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const WEEKDAYS_3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function CalendarWidget() {
  const [items, setItems] = useState<CalendarItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()))
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    loadCalendar()
      .then((payload) => {
        if (!cancelled) setItems(payload.items)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const today = useMemo(() => new Date(), [])
  const onCurrentMonth =
    cursor.getFullYear() === today.getFullYear() &&
    cursor.getMonth() === today.getMonth()

  const monthGrid = useMemo(
    () => buildMonthGrid(cursor.getFullYear(), cursor.getMonth()),
    [cursor],
  )

  // Bucket the items by the local ISO date(s) they cover, so each cell is
  // a cheap map lookup instead of a full scan over every item.
  const itemsByDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>()
    if (!items) return map
    for (const row of monthGrid) {
      for (const cell of row) {
        const key = toISODate(cell)
        const hits = items.filter((it) => itemCoversDate(it, cell))
        if (hits.length) map.set(key, hits)
      }
    }
    return map
  }, [monthGrid, items])

  function shiftMonth(n: number) {
    playSfx('tab')
    setCursor((c) => addMonths(c, n))
  }

  function goToday() {
    playSfx('tab')
    setCursor(startOfMonth(new Date()))
  }

  function jumpToMonth(month: Date) {
    playSfx('tab')
    setCursor(startOfMonth(month))
    setPickerOpen(false)
  }

  // ±6 months around the visible month — total 13 entries. Reused each
  // render; cheap enough to skip memoization (13 Date allocations).
  const pickerMonths: Date[] = []
  for (let offset = -6; offset <= 6; offset++) {
    pickerMonths.push(addMonths(cursor, offset))
  }

  // Close the month picker on outside click / Escape.
  useEffect(() => {
    if (!pickerOpen) return
    function onDown(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [pickerOpen])

  return (
    <section className="flex h-full min-h-0 flex-col">
      {items !== null && error === null && (
        <header className="flex items-center justify-center gap-2 mb-3 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
              className="rounded-md border border-line bg-surface hover:bg-surface-raised text-fg-muted h-7 w-7 inline-flex items-center justify-center transition-colors"
            >
              ‹
            </button>
            <div className="relative" ref={pickerRef}>
              <button
                type="button"
                onClick={() => {
                  playSfx('tab')
                  setPickerOpen((o) => !o)
                }}
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface hover:bg-surface-raised text-sm font-medium text-fg px-3 h-7 transition-colors"
                title="Pick a month"
              >
                <span className="min-w-[8ch] text-center">
                  {formatMonthHeading(cursor)}
                </span>
                <span
                  aria-hidden
                  className={
                    'text-fg-muted transition-transform ' +
                    (pickerOpen ? 'rotate-180' : '')
                  }
                >
                  <ChevronDownIcon className="w-3 h-3" />
                </span>
              </button>
              {pickerOpen && (
                <div
                  role="listbox"
                  className="absolute right-0 top-full mt-1 z-10 w-44 max-h-64 overflow-y-auto rounded-md border border-line-soft bg-surface shadow-lg p-1"
                >
                  {pickerMonths.map((m) => {
                    const isVisible =
                      m.getFullYear() === cursor.getFullYear() &&
                      m.getMonth() === cursor.getMonth()
                    const isThisMonth =
                      m.getFullYear() === today.getFullYear() &&
                      m.getMonth() === today.getMonth()
                    return (
                      <button
                        key={`${m.getFullYear()}-${m.getMonth()}`}
                        type="button"
                        role="option"
                        aria-selected={isVisible}
                        onClick={() => jumpToMonth(m)}
                        className={
                          'w-full text-left text-xs px-3 py-1.5 rounded transition-colors ' +
                          (isVisible
                            ? 'bg-accent-soft text-accent-soft-fg'
                            : 'text-fg hover:bg-surface-raised')
                        }
                      >
                        {formatMonthHeading(m)}
                        {isThisMonth && !isVisible && (
                          <span className="ml-2 text-[0.625rem] uppercase tracking-wider text-fg-faint">
                            today
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            <button
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
              className="rounded-md border border-line bg-surface hover:bg-surface-raised text-fg-muted h-7 w-7 inline-flex items-center justify-center transition-colors"
            >
              ›
            </button>
            {!onCurrentMonth && (
              <button
                onClick={goToday}
                className="rounded-full border border-line bg-surface hover:bg-surface-raised text-[0.625rem] uppercase tracking-wider text-fg-muted px-2.5 h-7 transition-colors"
                title="Jump to today"
              >
                Jump to today
              </button>
            )}
          </div>
        </header>
      )}

      {items === null && error === null && (
        <p className="text-xs text-fg-faint">Loading dates…</p>
      )}
      {error !== null && (
        <p className="text-xs text-danger-fg">Could not load calendar — {error}</p>
      )}

      {/* --- Full month grid: items listed under each day. flex-1 so it
          fills the tab height; the cell grid below uses grid-rows-6 to
          divide that height evenly across the six week rows. --- */}
      {items !== null && error === null && (
        <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-line overflow-hidden">
            {/* Weekday header */}
            <div className="grid grid-cols-7 bg-surface-soft border-b border-line shrink-0">
              {WEEKDAYS_3.map((w, i) => (
                <div
                  key={`${w}-${i}`}
                  className="px-2 py-1.5 text-center text-[0.625rem] uppercase tracking-wider text-fg-faint"
                >
                  <span className="sm:hidden">{WEEKDAYS_1[i]}</span>
                  <span className="hidden sm:inline">{w}</span>
                </div>
              ))}
            </div>

            {/* Day cells — gap-px over a bg-line parent draws the gridlines.
                auto-rows-fr splits the grid height evenly across the six week
                rows so the whole calendar always scales to fit the viewport —
                no whole-grid scrollbar. Each cell shows its full item list and
                scrolls inside itself only when that day's events don't fit;
                the tight cell padding + compact chips below keep as much of
                the cell as possible available for text before that happens. */}
            <div className="grid grid-cols-7 auto-rows-fr gap-px bg-line flex-1 min-h-0">
              {monthGrid.flat().map((cell) => {
                const key = toISODate(cell)
                const inMonth = cell.getMonth() === cursor.getMonth()
                const isToday = isSameDay(cell, today)
                const dayItems = itemsByDay.get(key) ?? []
                return (
                  <div
                    key={key}
                    className="min-h-0 min-w-0 p-1 flex flex-col gap-0.5 bg-surface overflow-hidden"
                  >
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span
                        aria-label={formatFullDate(cell)}
                        className={
                          isToday
                            ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accent-fg text-xs font-semibold'
                            : 'text-xs font-medium ' +
                              (inMonth ? 'text-fg' : 'text-fg-faint')
                        }
                      >
                        {cell.getDate()}
                      </span>
                      {/* One colored dot per item, listed on the date line —
                          a glanceable category summary. The titles below
                          render as plain text (their dots moved up here). */}
                      {dayItems.length > 0 && (
                        <div className="flex flex-wrap items-center gap-0.5 min-w-0">
                          {dayItems.map((it) => (
                            <span
                              key={it.id}
                              aria-hidden
                              title={it.title}
                              className={
                                `h-1.5 w-1.5 rounded-full shrink-0 ${CATEGORY_DOT[it.category]} ` +
                                (inMonth ? '' : 'opacity-50')
                              }
                            />
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-1 min-h-0 flex-col gap-0.5 min-w-0 overflow-y-auto">
                      {dayItems.map((it) => (
                        <DayChip key={it.id} item={it} dim={!inMonth} />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
      )}
    </section>
  )
}

// A single item rendered inside a day cell — just the title text (its
// category dot now lives up on the date line). Links out to the source page
// when there's a URL. `dim` softens spillover-day items so the current month
// still reads as the focus. Kept padding-free vertically so more titles fit
// in the cell before it needs to scroll.
function DayChip({ item, dim }: { item: CalendarItem; dim: boolean }) {
  const titleAttr = item.description
    ? `${item.title} — ${item.description}`
    : item.title
  const inner = (
    <span className="flex items-start px-1 min-w-0">
      <span
        className={
          'min-w-0 break-words text-[0.6875rem] leading-tight ' +
          (dim ? 'text-fg-faint' : 'text-fg-muted')
        }
      >
        {item.title}
      </span>
    </span>
  )
  if (item.url) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        title={titleAttr}
        className="block min-w-0"
      >
        {inner}
      </a>
    )
  }
  return (
    <div title={titleAttr} className="min-w-0">
      {inner}
    </div>
  )
}
