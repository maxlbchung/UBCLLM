// Year-by-year program-requirements checklist. Renders the parsed
// "Specialization Requirements" tables (see lib/programYears) as a checklist
// grouped by year: each course row is checkable (auto-ticked when a satisfying
// course is in the plan, and manually toggleable for transfer credit the user
// won't place on the board), each text row (Electives, "Any upper level
// MATH/STAT…") is advisory only and never counts toward progress.
import { useMemo } from 'react'
import {
  isRequirementMet,
  requirementKey,
  type ParsedProgramYears,
  type YearRequirement,
} from '../../lib/programYears'
import { usePlanner } from '../../store/planner'
import { playSfx } from '../../lib/sfx'
import { CheckIcon, CheckSquareIcon, SquareIcon } from '../icons'

interface YearRequirementsProps {
  programUrl: string
  parsed: ParsedProgramYears
  plannedCodes: Set<string>
}

// Drop the "_V" campus suffix for display: "MATH_V 100 (or 180…)" → "MATH 100…"
function cleanLabel(label: string): string {
  return label.replace(/_V/g, '')
}

export function YearRequirements({
  programUrl,
  parsed,
  plannedCodes,
}: YearRequirementsProps) {
  const checkedRequirements = usePlanner((s) => s.checkedRequirements)
  const toggleRequirement = usePlanner((s) => s.toggleRequirement)
  const checkedSet = useMemo(
    () => new Set(checkedRequirements),
    [checkedRequirements],
  )

  // Overall progress measured in credits: a row contributes its credit value
  // once met — a course row by a plan block or manual check, a text/literal row
  // (Electives, "Any upper level MATH/STAT…") only once manually checked. The
  // denominator is the official degree total when the page gives one, else the
  // sum of all listed requirement credits.
  const { doneCredits, totalCredits } = useMemo(() => {
    let done = 0
    let sum = 0
    for (const year of parsed.years) {
      for (const item of year.items) {
        const cr = item.credits ?? 0
        sum += cr
        const key = requirementKey(programUrl, year.label, item)
        if (isRequirementMet(item, plannedCodes) || checkedSet.has(key)) {
          done += cr
        }
      }
    }
    return { doneCredits: done, totalCredits: parsed.degreeTotalCredits ?? sum }
  }, [parsed, plannedCodes, checkedSet, programUrl])

  const pct =
    totalCredits === 0 ? 0 : Math.min(100, (doneCredits / totalCredits) * 100)

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="rounded border border-line bg-surface-soft p-2 flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <span className="text-fg">Requirements</span>
          <span className="text-xs text-fg-muted">
            {doneCredits}/{totalCredits} Credits
          </span>
        </div>
        <div className="h-1.5 rounded bg-line overflow-hidden">
          <div
            className="h-full bg-accent transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {parsed.years.map((year) => (
        <div key={year.label} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between">
            <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide">
              {year.label}
            </h4>
            {year.totalCredits != null && (
              <span className="text-xs text-fg-faint">
                {year.totalCredits}
              </span>
            )}
          </div>
          <ul className="flex flex-col gap-0.5">
            {year.items.map((item, idx) => {
              const key = requirementKey(programUrl, year.label, item)
              const manuallyChecked = checkedSet.has(key)
              return (
                <RequirementRow
                  key={`${year.label}-${idx}`}
                  item={item}
                  met={isRequirementMet(item, plannedCodes)}
                  manuallyChecked={manuallyChecked}
                  plannedCount={
                    item.codes.filter((c) => plannedCodes.has(c)).length
                  }
                  onToggle={() => {
                    toggleRequirement(key)
                    playSfx(manuallyChecked ? 'toggleOff' : 'toggleOn')
                  }}
                />
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

function RequirementRow({
  item,
  met,
  manuallyChecked,
  plannedCount,
  onToggle,
}: {
  item: YearRequirement
  met: boolean
  manuallyChecked: boolean
  plannedCount: number
  onToggle: () => void
}) {
  const label = cleanLabel(item.label)
  const credits =
    item.credits != null ? (
      <span className="shrink-0 text-fg-faint tabular-nums">
        {item.credits}
      </span>
    ) : null

  // A literal course block in the plan already fulfills this requirement, so
  // the plan is the source of truth — the row is locked (not a button, no
  // toggle, no sfx). The user satisfies it by placing/removing the block.
  // Only course rows can reach this (text rows are never auto-met).
  if (met) {
    return (
      <li
        title="Satisfied by a course in your plan"
        className="flex items-baseline gap-2 px-1 py-0.5 text-xs cursor-default"
      >
        <CheckIcon className="w-3.5 h-3.5 self-center shrink-0 text-accent" />
        <span className="flex-1 text-fg">{label}</span>
        {credits}
      </li>
    )
  }

  // Otherwise the user fulfills the row by manually checking it: a course not
  // in the plan (transfer credit, AP) or a text/literal requirement (Electives,
  // "Any upper level MATH/STAT…") that has no specific block to drag.
  // Partial hint for an "all of" course group where some but not all are planned.
  const partial =
    item.kind === 'course' &&
    !manuallyChecked &&
    item.codes.length > 1 &&
    plannedCount > 0
      ? ` · ${plannedCount}/${item.codes.length}`
      : ''

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        title="Click to mark complete"
        className="w-full flex items-baseline gap-2 px-1 py-0.5 text-xs rounded hover:bg-surface-raised text-left"
      >
        {manuallyChecked ? (
          <CheckSquareIcon className="w-3.5 h-3.5 self-center shrink-0 text-accent" />
        ) : (
          <SquareIcon className="w-3.5 h-3.5 self-center shrink-0 text-fg-faint" />
        )}
        <span
          className={`flex-1 ${manuallyChecked ? 'text-fg' : 'text-fg-muted'}`}
        >
          {label}
          {partial && <span className="text-fg-faint">{partial}</span>}
        </span>
        {credits}
      </button>
    </li>
  )
}
