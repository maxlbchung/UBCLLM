// "Plan structure" preferences block — year count + terms per year. Lives
// at the top of the Preferences sidebar tab so the structural controls
// are grouped with the program selectors instead of cluttering the page
// header. Shrinking either dimension can drop already-planned blocks, so
// both selectors guard the change with a confirm naming the loss.
import {
  MAX_TERMS,
  MAX_YEARS,
  MIN_TERMS,
  MIN_YEARS,
  usePlanner,
} from '../../store/planner'
import { playSfx } from '../../lib/sfx'

export function PlanStructure() {
  const years = usePlanner((s) => s.years)
  const termsPerYear = usePlanner((s) => s.termsPerYear)
  const setYearCount = usePlanner((s) => s.setYearCount)
  const setTermsPerYear = usePlanner((s) => s.setTermsPerYear)

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg">Structure</h3>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-xs text-fg-muted">Years</span>
          <select
            value={years.length}
            onChange={(e) => {
              const next = Number(e.target.value)
              if (next >= years.length) {
                setYearCount(next)
                playSfx('click')
                return
              }
              const droppedBlocks = years
                .slice(next)
                .reduce(
                  (n, y) =>
                    n + y.terms.reduce((m, t) => m + t.blocks.length, 0),
                  0,
                )
              if (
                droppedBlocks > 0 &&
                !window.confirm(
                  `Reducing to ${next} years will discard ${droppedBlocks} planned course(s). Continue?`,
                )
              ) {
                return
              }
              setYearCount(next)
              playSfx('click')
            }}
            className="bg-input border border-line-soft text-fg rounded px-2 py-1 text-sm focus:outline-none focus:border-fg-faint"
          >
            {Array.from(
              { length: MAX_YEARS - MIN_YEARS + 1 },
              (_, i) => MIN_YEARS + i,
            ).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-xs text-fg-muted">Terms</span>
          <select
            value={termsPerYear}
            onChange={(e) => {
              const next = Number(e.target.value)
              if (next >= termsPerYear) {
                setTermsPerYear(next)
                playSfx('click')
                return
              }
              const droppedBlocks = years.reduce(
                (n, y) =>
                  n +
                  y.terms
                    .slice(next)
                    .reduce((m, t) => m + t.blocks.length, 0),
                0,
              )
              if (
                droppedBlocks > 0 &&
                !window.confirm(
                  `Reducing to ${next} term${next === 1 ? '' : 's'} per year will discard ${droppedBlocks} planned course(s). Continue?`,
                )
              ) {
                return
              }
              setTermsPerYear(next)
              playSfx('click')
            }}
            className="bg-input border border-line-soft text-fg rounded px-2 py-1 text-sm focus:outline-none focus:border-fg-faint"
          >
            {Array.from(
              { length: MAX_TERMS - MIN_TERMS + 1 },
              (_, i) => MIN_TERMS + i,
            ).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}
