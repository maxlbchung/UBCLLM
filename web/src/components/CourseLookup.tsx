import { useEffect, useMemo, useState } from 'react'
import {
  getCourseIndex,
  parseCourseChunk,
  type ParsedCourse,
} from '../lib/retrieve'

function normalize(query: string): string {
  // Accept "cpsc 110", "CPSC110", "CPSC_V 110" → "CPSC 110"
  const m = query.toUpperCase().match(/^([A-Z]{2,5})(?:_V)?\s*(\d{2,4}[A-Z]?)$/)
  if (!m) return query.toUpperCase().replace(/\s+/g, ' ').trim()
  return `${m[1]} ${m[2]}`
}

export function CourseLookup() {
  const [index, setIndex] = useState<Map<string, import('../lib/retrieve').Chunk> | null>(null)
  const [query, setQuery] = useState('')
  const [course, setCourse] = useState<ParsedCourse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])

  useEffect(() => {
    void getCourseIndex().then(setIndex)
  }, [])

  const codes = useMemo(() => (index ? Array.from(index.keys()).sort() : []), [index])

  function lookup(raw: string) {
    const code = normalize(raw)
    setQuery(raw)
    setError(null)
    if (!index) return
    const chunk = index.get(code)
    if (chunk) {
      setCourse(parseCourseChunk(chunk))
      setSuggestions([])
      return
    }
    setCourse(null)
    if (code.length >= 4) {
      const matches = codes
        .filter((c) => c.replaceAll(' ', '').includes(code.replaceAll(' ', '')))
        .slice(0, 8)
      setSuggestions(matches)
      if (matches.length === 0) setError(`No course matches "${raw}".`)
    } else {
      setSuggestions([])
    }
  }

  if (!index) {
    return <div className="p-6 text-zinc-500">Loading course index…</div>
  }

  return (
    <div className="flex flex-col h-screen p-6 gap-4 max-w-3xl mx-auto w-full">
      <header>
        <h2 className="text-xl font-semibold">Course Lookup</h2>
        <p className="text-sm text-zinc-400">
          {codes.length.toLocaleString()} courses · UBC Vancouver
        </p>
      </header>

      <input
        autoFocus
        value={query}
        onChange={(e) => lookup(e.target.value)}
        placeholder="e.g. CPSC 110, math 200, ENGL 112"
        className="rounded bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
      />

      {error && <p className="text-sm text-red-400">{error}</p>}

      {suggestions.length > 0 && (
        <div className="text-sm text-zinc-400">
          <p className="mb-1">Did you mean:</p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => lookup(s)}
                className="rounded bg-zinc-800 hover:bg-zinc-700 px-2 py-1 text-xs"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {course && <CourseCard course={course} />}
    </div>
  )
}

function CourseCard({ course }: { course: ParsedCourse }) {
  const fields: { label: string; value: string | undefined }[] = [
    { label: 'Credits', value: course.credits },
    { label: 'Prerequisites', value: course.prerequisites },
    { label: 'Corequisites', value: course.corequisites },
    { label: 'Equivalency', value: course.equivalency },
    { label: 'Recommended', value: course.recommended },
  ]
  return (
    <article className="rounded border border-zinc-800 bg-zinc-900/60 p-4 space-y-3 overflow-y-auto">
      <header>
        <h3 className="text-lg font-semibold">
          {course.code} <span className="text-zinc-400">— {course.title}</span>
        </h3>
        <a
          href={course.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-400 hover:underline"
        >
          UBC calendar ↗
        </a>
      </header>

      {course.description && (
        <p className="text-sm text-zinc-200 leading-relaxed">{course.description}</p>
      )}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm">
        {fields
          .filter((f) => f.value)
          .map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-zinc-500">{f.label}</dt>
              <dd className="text-zinc-200">{f.value}</dd>
            </div>
          ))}
      </dl>
    </article>
  )
}
