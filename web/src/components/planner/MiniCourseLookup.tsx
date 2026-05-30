// Mini course search for the planner sidebar. Single input — accepts the
// same code/subject/filter syntax as the full Course Finder page (via
// parseQuery) but also falls through to substring matching on title so
// "linear algebra" surfaces MATH 152 etc. Results are LookupBlocks that
// drag straight into year-column terms.
import { useEffect, useMemo, useRef, useState } from 'react'
import { LookupBlock } from './LookupBlock'
import { searchCourses } from '../../lib/courseQuery'
import type { Chunk } from '../../lib/retrieve'

const RESULT_LIMIT = 20

interface MiniCourseLookupProps {
  courseIndex: Map<string, Chunk>
}

export function MiniCourseLookup({ courseIndex }: MiniCourseLookupProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const results = useMemo(() => {
    if (!query.trim()) return [] as Chunk[]
    return searchCourses(courseIndex, query, RESULT_LIMIT)
  }, [query, courseIndex])

  return (
    <div className="flex flex-col gap-2 min-h-0">
      <h3 className="text-sm font-semibold text-fg">Find courses</h3>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Code or title (e.g. CPSC 110, linear algebra)"
        className="w-full rounded bg-input border border-line-soft text-fg px-2 py-1.5 text-sm focus:outline-none focus:border-fg-faint"
      />
      <div className="flex-1 overflow-y-auto flex flex-col gap-1 min-h-0">
        {query.trim() && results.length === 0 && (
          <p className="text-xs text-fg-faint italic">No matches.</p>
        )}
        {results.map((chunk) => (
          <LookupBlock key={chunk.id} chunk={chunk} />
        ))}
      </div>
    </div>
  )
}
