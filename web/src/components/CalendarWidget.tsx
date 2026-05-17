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

// Per-category color tokens. Academic and event step outside the
// existing palette (brighter blue + violet) for visual separation —
// applied via arbitrary Tailwind classes so we don't have to widen
// `index.css`. Holiday stays on `bg-highlight` (amber) to ride the
// existing theme.
const CATEGORY_DOT: Record<CalendarCategory, string> = {
  academic: 'bg-[#60a5fa]', // tailwind blue-400 — brighter than --accent
  holiday: 'bg-highlight',
  event: 'bg-[#a855f7]', // tailwind purple-500
}

const CATEGORY_LABEL: Record<CalendarCategory, string> = {
  academic: 'Academic',
  holiday: 'Holidays',
  event: 'Events',
}

type FilterState = Record<CalendarCategory, boolean>

const DEFAULT_FILTERS: FilterState = { academic: true, holiday: true, event: true }

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export function CalendarWidget() {
  const [items, setItems] = useState<CalendarItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()))
  const [selected, setSelected] = useState<Date>(() => new Date())
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS)
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

  const filteredItems = useMemo(() => {
    if (!items) return []
    return items.filter((it) => filters[it.category])
  }, [items, filters])

  const today = useMemo(() => new Date(), [])
  const onCurrentMonth =
    cursor.getFullYear() === today.getFullYear() &&
    cursor.getMonth() === today.getMonth()

  const selectedItems = useMemo(() => {
    return filteredItems.filter((it) => itemCoversDate(it, selected))
  }, [filteredItems, selected])

  const monthGrid = useMemo(
    () => buildMonthGrid(cursor.getFullYear(), cursor.getMonth()),
    [cursor],
  )

  function toggle(cat: CalendarCategory) {
    const next = !filters[cat]
    playSfx(next ? 'toggleOn' : 'toggleOff')
    setFilters((f) => ({ ...f, [cat]: next }))
  }

  function shiftMonth(n: number) {
    playSfx('tab')
    setCursor((c) => addMonths(c, n))
  }

  function goToday() {
    playSfx('tab')
    const now = new Date()
    setCursor(startOfMonth(now))
    setSelected(now)
  }

  function pickDay(cell: Date) {
    playSfx('tab')
    setSelected(cell)
    // If the clicked cell is in the spillover for an adjacent month,
    // slide the visible month with it so the highlight stays in view.
    if (cell.getMonth() !== cursor.getMonth()) {
      setCursor(startOfMonth(cell))
    }
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
    <section className="rounded-lg border border-line bg-surface-soft p-5">
      <header className="flex flex-wrap items-center gap-2 mb-4">
        <h2 className="text-sm font-semibold text-fg">Upcoming at UBC</h2>
        <span className="text-xs text-fg-faint">Events, deadlines, holidays, and more!</span>
      </header>

      {items === null && error === null && (
        <p className="text-xs text-fg-faint">Loading dates…</p>
      )}
      {error !== null && (
        <p className="text-xs text-danger-fg">Could not load calendar — {error}</p>
      )}

      {items !== null && error === null && (
        <div className="grid grid-cols-1 md:grid-cols-[auto_1px_1fr] gap-5">
          {/* --- Mini month grid --- */}
          <div>
            <div className="flex items-center justify-center gap-2 mb-2">
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
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface hover:bg-surface-raised text-xs font-medium text-fg px-2.5 h-7 transition-colors"
                  title="Pick a month"
                >
                  <span className="min-w-[7ch] text-center">
                    {formatMonthHeading(cursor)}
                  </span>
                  <span
                    aria-hidden
                    className={
                      'text-fg-muted text-[0.625rem] transition-transform ' +
                      (pickerOpen ? 'rotate-180' : '')
                    }
                  >
                    ▾
                  </span>
                </button>
                {pickerOpen && (
                  <div
                    role="listbox"
                    className="absolute left-1/2 top-full mt-1 -translate-x-1/2 z-10 w-44 max-h-64 overflow-y-auto rounded-md border border-line-soft bg-surface shadow-lg p-1"
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
            </div>

            <div className="grid w-fit grid-cols-7 gap-0.5 text-center mb-1">
              {WEEKDAYS.map((w, i) => (
                <span
                  key={`${w}-${i}`}
                  className="h-6 w-6 inline-flex items-center justify-center text-[0.625rem] uppercase tracking-wider text-fg-faint"
                >
                  {w}
                </span>
              ))}
            </div>

            <div className="grid w-fit grid-cols-7 gap-0.5">
              {monthGrid.flat().map((cell) => {
                const inMonth = cell.getMonth() === cursor.getMonth()
                const isToday = isSameDay(cell, today)
                const isSelected = isSameDay(cell, selected)
                const matches = filteredItems.filter((it) => itemCoversDate(it, cell))
                // One dot per category present on the day, in the same
                // order as the filter toggles — small markers don't try
                // to convey count, just "which kinds happen today".
                const presentCats = (
                  ['academic', 'holiday', 'event'] as CalendarCategory[]
                ).filter((c) => matches.some((m) => m.category === c))
                // Layered visuals:
                //   - today always carries a subtle lighter background
                //     so the "where am I in time" anchor never disappears,
                //     even when the user has picked a different day.
                //   - the selected day overlays an accent ring + slightly
                //     stronger fill so it reads as the active pick.
                const base = isSelected
                  ? 'bg-accent-soft text-accent-soft-fg ring-1 ring-accent ring-inset'
                  : isToday
                    ? 'bg-surface-raised text-fg'
                    : inMonth
                      ? 'text-fg hover:bg-surface-raised/60'
                      : 'text-fg-faint opacity-60 hover:bg-surface-raised/40'
                return (
                  <button
                    key={toISODate(cell)}
                    type="button"
                    onClick={() => pickDay(cell)}
                    aria-pressed={isSelected}
                    aria-label={`${formatFullDate(cell)}${matches.length ? `, ${matches.length} item${matches.length === 1 ? '' : 's'}` : ''}`}
                    className={
                      'relative h-6 w-6 inline-flex items-center justify-center text-xs leading-none rounded transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ' +
                      base
                    }
                  >
                    {cell.getDate()}
                    {presentCats.length > 0 && (
                      <span
                        aria-hidden
                        className="absolute bottom-0.5 left-1/2 -translate-x-1/2 flex gap-[2px]"
                      >
                        {presentCats.map((c) => (
                          <span
                            key={c}
                            className={`block h-[3px] w-[3px] rounded-full ${CATEGORY_DOT[c]}`}
                          />
                        ))}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Floating horizontal divider between the calendar grid
                and the controls below — same `bg-line` rule shaved on
                the sides so it reads as a floating separator within
                the left column. */}
            <div
              aria-hidden
              className="h-px bg-line mx-2 my-3"
            />

            {/* Toggles sit in a single-column grid sized to the widest
                pill's natural max-content, so all three share the same
                width without spanning the full column. */}
            <div className="grid grid-cols-[max-content] gap-2">
              {(['academic', 'holiday', 'event'] as CalendarCategory[]).map(
                (cat) => (
                  <CategoryToggle
                    key={cat}
                    category={cat}
                    checked={filters[cat]}
                    onChange={() => toggle(cat)}
                  />
                ),
              )}
            </div>
            {!onCurrentMonth && (
              <button
                onClick={goToday}
                className="self-start rounded-full border border-line bg-surface hover:bg-surface-raised text-[0.625rem] uppercase tracking-wider text-fg-muted px-2 py-0.5 transition-colors mt-3"
                title="Jump to today"
              >
                Jump to today
              </button>
            )}
          </div>

          {/* Floating vertical divider — hidden on mobile (single column).
              `my-2` shaves a bit off the top/bottom so the line doesn't
              touch the calendar's chrome and reads as a floating rule. */}
          <div aria-hidden className="hidden md:block w-px bg-line my-2 self-stretch" />

          {/* --- Selected-day list --- */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-fg-faint mb-2">
              {formatFullDate(selected)}
              {isSameDay(selected, today) && (
                <span className="ml-2 text-fg-muted normal-case tracking-normal">
                  · TODAY
                </span>
              )}
            </h3>
            {selectedItems.length === 0 ? (
              <p className="text-xs text-fg-muted">Nothing scheduled.</p>
            ) : (
              <ul className="flex flex-col">
                {selectedItems.map((it) => (
                  <DayRow key={it.id} item={it} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

// Pill-shaped switch borrowing the geometry from OtherPage's ThemedToggle
// (22px track, 40px wide, 14px thumb sliding left:4 → left:22). The
// thumb takes the category color so each toggle is visually keyed to
// the dots used in the grid + upcoming list. When off, the thumb falls
// back to the neutral grey puck used in settings so disabled state
// reads consistently across the app.
const TRACK_TINT: Record<CalendarCategory, string> = {
  academic: 'bg-[#60a5fa]/20 hover:bg-[#60a5fa]/30',
  holiday: 'bg-highlight-soft hover:bg-[var(--highlight)]/30',
  event: 'bg-[#a855f7]/20 hover:bg-[#a855f7]/30',
}

function CategoryToggle({
  category,
  checked,
  onChange,
}: {
  category: CalendarCategory
  checked: boolean
  onChange: () => void
}) {
  const id = `calendar-filter-${category}`
  return (
    <div className="flex w-full items-center justify-between gap-2 rounded-full border border-line bg-surface px-3 py-1">
      <label htmlFor={id} className="text-xs text-fg-muted select-none cursor-pointer">
        {CATEGORY_LABEL[category]}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={
          'relative h-[22px] w-[40px] rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 ' +
          (checked
            ? TRACK_TINT[category]
            : 'bg-surface-raised hover:bg-line-soft')
        }
      >
        <span
          aria-hidden
          className={
            'absolute top-[4px] block h-[14px] w-[14px] rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.45)] transition-[left,background-color] duration-150 ' +
            (checked
              ? `left-[22px] ${CATEGORY_DOT[category]}`
              : 'left-[4px] bg-fg-muted')
          }
        />
      </button>
    </div>
  )
}

function DayRow({ item }: { item: CalendarItem }) {
  const body = (
    <div className="flex items-start gap-2 py-2 px-2 -mx-2 rounded-md hover:bg-surface-raised transition-colors">
      <span
        aria-hidden
        className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${CATEGORY_DOT[item.category]}`}
      />
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="text-sm font-medium leading-snug">
          {item.title}
        </span>
        {item.description && (
          <span className="text-xs text-fg-muted truncate">
            {item.description}
          </span>
        )}
      </div>
    </div>
  )
  if (item.url) {
    return (
      <li>
        <a href={item.url} target="_blank" rel="noreferrer" className="block">
          {body}
        </a>
      </li>
    )
  }
  return <li>{body}</li>
}
