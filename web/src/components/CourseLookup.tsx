import { useEffect, useMemo, useState } from 'react'
import {
  getCourseIndex,
  parseCourseChunk,
  type Chunk,
  type ParsedCourse,
} from '../lib/retrieve'

type ParsedQuery =
  | { kind: 'none' }
  | { kind: 'exact'; code: string }
  | { kind: 'subject'; subject: string }
  | { kind: 'filter'; subject: string; digit: number; op: '=' | '+' | '-' }

/**
 * Parse a lookup-bar input into one of:
 *   - exact:   "CPSC 110"            → single course
 *   - subject: "CPSC"                → all courses in that subject
 *   - filter:  "CPSC 100 =" / "+" / "-" → all courses in subject whose first
 *              digit equals / is ≥ / is ≤ the query's first digit
 *
 * Both bounds are inclusive: `200 +` covers 2xx upward, `250 -` covers 2xx
 * downward, `100 =` is exactly 1xx.
 */
function parseQuery(raw: string): ParsedQuery {
  const q = raw.toUpperCase().trim()
  if (!q) return { kind: 'none' }

  const filterMatch = q.match(
    /^([A-Z]{2,5})(?:_V)?\s*(\d{2,4}[A-Z]?)\s*([=+\-])$/,
  )
  if (filterMatch) {
    return {
      kind: 'filter',
      subject: filterMatch[1],
      digit: Number(filterMatch[2][0]),
      op: filterMatch[3] as '=' | '+' | '-',
    }
  }

  const exactMatch = q.match(/^([A-Z]{2,5})(?:_V)?\s*(\d{2,4}[A-Z]?)$/)
  if (exactMatch) {
    return { kind: 'exact', code: `${exactMatch[1]} ${exactMatch[2]}` }
  }

  const subjectMatch = q.match(/^([A-Z]{2,5})(?:_V)?$/)
  if (subjectMatch) {
    return { kind: 'subject', subject: subjectMatch[1] }
  }

  return { kind: 'none' }
}

function describeFilter(p: Extract<ParsedQuery, { kind: 'filter' }>): string {
  const lvl = `${p.digit}xx`
  if (p.op === '=') return `${p.subject} courses at the ${lvl} level`
  if (p.op === '+') return `${p.subject} courses at ${lvl} and above`
  return `${p.subject} courses at ${lvl} and below`
}

export function CourseLookup() {
  const [index, setIndex] = useState<Map<string, Chunk> | null>(null)
  const [query, setQuery] = useState('')
  const [course, setCourse] = useState<ParsedCourse | null>(null)
  const [matches, setMatches] = useState<Chunk[]>([])
  const [matchHeading, setMatchHeading] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])

  useEffect(() => {
    void getCourseIndex().then(setIndex)
  }, [])

  const codes = useMemo(
    () => (index ? Array.from(index.keys()).sort() : []),
    [index],
  )

  function lookup(raw: string) {
    setQuery(raw)
    setError(null)
    if (!index) return

    const parsed = parseQuery(raw)

    if (parsed.kind === 'none') {
      setCourse(null)
      setMatches([])
      setMatchHeading('')
      setSuggestions([])
      return
    }

    if (parsed.kind === 'exact') {
      const chunk = index.get(parsed.code)
      if (chunk) {
        setCourse(parseCourseChunk(chunk))
        setMatches([])
        setMatchHeading('')
        setSuggestions([])
        return
      }
      setCourse(null)
      setMatches([])
      setMatchHeading('')
      const codeNoSpace = parsed.code.replaceAll(' ', '')
      const matched = codes
        .filter((c) => c.replaceAll(' ', '').includes(codeNoSpace))
        .slice(0, 8)
      setSuggestions(matched)
      if (matched.length === 0) setError(`No course matches "${raw}".`)
      return
    }

    // subject or filter — both produce a list of matching courses
    const prefix = `${parsed.subject} `
    let codesForSubject = codes.filter((c) => c.startsWith(prefix))
    if (parsed.kind === 'filter') {
      const { digit, op } = parsed
      codesForSubject = codesForSubject.filter((c) => {
        const num = c.split(' ')[1]
        if (!num) return false
        const d = Number(num[0])
        if (Number.isNaN(d)) return false
        if (op === '=') return d === digit
        if (op === '+') return d >= digit
        return d <= digit
      })
    }

    const chunks = codesForSubject
      .map((c) => index.get(c))
      .filter((c): c is Chunk => Boolean(c))

    setMatches(chunks)
    setMatchHeading(
      parsed.kind === 'filter'
        ? describeFilter(parsed)
        : `${parsed.subject} courses`,
    )
    setCourse(null)
    setSuggestions([])
    if (chunks.length === 0) {
      setError(
        parsed.kind === 'filter'
          ? `No ${describeFilter(parsed)}.`
          : `No courses found for subject "${parsed.subject}".`,
      )
    }
  }

  if (!index) {
    return <div className="p-6 text-zinc-500">Loading course index…</div>
  }

  return (
    <div className="flex flex-col h-screen p-6 gap-4 max-w-3xl mx-auto w-full min-h-0">
      <header>
        <h2 className="text-xl font-semibold">Course Lookup</h2>
        <p className="text-sm text-zinc-400">
          {codes.length.toLocaleString()} courses · UBC Vancouver
        </p>
        <p className="text-xs text-zinc-500 mt-1">
          Type <span className="font-mono text-zinc-300">CPSC 110</span> for one course,{' '}
          <span className="font-mono text-zinc-300">CPSC</span> for the whole
          subject, or add an operator: <span className="font-mono text-zinc-300">CPSC 100 =</span>{' '}
          (only 1xx),{' '}
          <span className="font-mono text-zinc-300">CPSC 200 +</span> (2xx and up),{' '}
          <span className="font-mono text-zinc-300">CPSC 250 -</span> (2xx and below).
        </p>
      </header>

      <input
        autoFocus
        value={query}
        onChange={(e) => lookup(e.target.value)}
        placeholder="e.g. CPSC 110, CPSC, CPSC 200 +"
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

      <div className="flex-1 overflow-y-auto flex flex-col gap-3 min-h-0">
        {matches.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <p className="text-xs text-zinc-500">
              {matches.length.toLocaleString()} {matchHeading} ({matches.length === 1 ? 'match' : 'matches'})
            </p>
            <ul className="flex flex-col gap-1">
              {matches.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setCourse(parseCourseChunk(c))}
                    className="w-full text-left rounded border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 hover:border-zinc-700 px-3 py-2 text-sm"
                  >
                    <span className="font-mono text-zinc-100">{c.code}</span>
                    <span className="text-zinc-400"> — {c.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {course && <CourseCard course={course} />}
      </div>
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
    <article className="rounded border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
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
