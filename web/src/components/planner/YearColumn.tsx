// One year column: just a label and a stack of TermSections. Term count
// is uniform across the whole planner (set in the page header), so this
// component is presentation-only.
import { TermSection } from './TermSection'
import type { Chunk } from '../../lib/retrieve'
import type { BlockValidation } from './validation'
import type { Year } from '../../store/planner'

interface YearColumnProps {
  year: Year
  courseIndex: Map<string, Chunk>
  validations: Map<string, BlockValidation>
  requirementCodes: Set<string>
}

export function YearColumn({
  year,
  courseIndex,
  validations,
  requirementCodes,
}: YearColumnProps) {
  return (
    <section className="flex flex-col gap-2 min-w-0 min-h-0 h-full">
      <header className="px-1 shrink-0">
        <h3 className="text-sm font-semibold text-fg">{year.label}</h3>
      </header>
      <div className="flex-1 min-h-0 flex flex-col gap-2">
        {year.terms.map((term, idx) => (
          <TermSection
            key={`${year.id}-${idx}`}
            yearId={year.id}
            termIdx={idx}
            term={term}
            courseIndex={courseIndex}
            validations={validations}
            requirementCodes={requirementCodes}
          />
        ))}
      </div>
    </section>
  )
}
