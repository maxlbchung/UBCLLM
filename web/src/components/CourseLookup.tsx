import { useEffect, useMemo, useState } from 'react'
import {
  getCourseIndex,
  parseCourseChunk,
  type Chunk,
  type ParsedCourse,
} from '../lib/retrieve'
import { ABCD_EASTER_ID, useEasterEggs } from '../store/easterEggs'

type ParsedQuery =
  | { kind: 'none' }
  | { kind: 'exact'; code: string }
  | { kind: 'subject'; subject: string }
  | { kind: 'filter'; subject: string; digit: number; op: '=' | '+' | '-' }
  | { kind: 'invalidFilter'; reason: string }

/**
 * Parse a lookup-bar input into one of:
 *   - exact:   "CPSC 110" / "CPSC 22" → code-shaped query (1–4 digits).
 *              lookup() resolves these in two stages: first index.get(code)
 *              for a complete code, falling back to a prefix scan over
 *              `codes` so partial numbers ("CPSC 22") surface CPSC 220,
 *              221, 226, … as an expandable list.
 *   - subject: "CPSC"                → all courses in that subject
 *   - filter:  "CPSC 100 =" / "+" / "-" → all courses in subject whose first
 *              digit equals / is ≥ / is < the query's first digit
 *
 * "+" includes the boundary digit; "-" excludes it. So `200 +` covers 2xx
 * upward, `250 -` covers 1xx only, `100 =` is exactly 1xx.
 *
 * Filters are only accepted when the number is in X00 form (the canonical
 * level boundary — 100, 200, …). A trailing operator on any other number
 * yields an `invalidFilter` so the UI can explain instead of silently
 * dropping the query.
 */
function parseQuery(raw: string): ParsedQuery {
  const q = raw.toUpperCase().trim()
  if (!q) return { kind: 'none' }

  // Trailing operator means the user is asking for a level filter.
  const opMatch = q.match(/^(.+?)\s*([=+\-])$/)
  if (opMatch) {
    const prefix = opMatch[1].trim()
    const op = opMatch[2] as '=' | '+' | '-'
    const filterMatch = prefix.match(/^([A-Z]{2,5})(?:_V)?\s*(\d)00$/)
    if (filterMatch) {
      return {
        kind: 'filter',
        subject: filterMatch[1],
        digit: Number(filterMatch[2]),
        op,
      }
    }
    return {
      kind: 'invalidFilter',
      reason:
        'Filters need the X00 form, e.g. CPSC 100 =, DSCI 200 +, WRDS 100 -.',
    }
  }

  // Code-shape input: subject + 1–4 digits, optional letter suffix. The
  // 1-digit lower bound is what powers partial-prefix lookups (e.g.
  // "CPSC 2" → all CPSC 2xx/2xxx). lookup() resolves the exact branch by
  // first trying index.get(code); on miss it falls back to a prefix scan
  // over `codes`, so this regex doesn't need a separate `partial` kind.
  const exactMatch = q.match(/^([A-Z]{2,5})(?:_V)?\s*(\d{1,4}[A-Z]?)$/)
  if (exactMatch) {
    return { kind: 'exact', code: `${exactMatch[1]} ${exactMatch[2]}` }
  }

  const subjectMatch = q.match(/^([A-Z]{2,5})(?:_V)?$/)
  if (subjectMatch) {
    return { kind: 'subject', subject: subjectMatch[1] }
  }

  return { kind: 'none' }
}

// Hidden easter — typed "ABCD" in the lookup bar surfaces this as the only
// match. No real UBC subject code is ABCD, so this can't collide with a
// legitimate search. Text is laid out in the pipeline's chunk format so
// parseCourseChunk lifts Credits + Prerequisites out into their fields and
// leaves the description (with the song embedded) for CourseCard. The id
// is shared with easterEggs.ts via ABCD_EASTER_ID so markDiscovered ↔
// validIds use the same string.
const ABCD_EASTER_CHUNK: Chunk = {
  id: ABCD_EASTER_ID,
  kind: 'course',
  code: 'ABCD 123',
  title: 'Introduction to the Alphabet',
  text: [
    'ABCD 123: Introduction to the Alphabet',
    'Credits: 26',
    "A foundational survey of the 26-letter Latin alphabet, taught entirely through song: A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X, Y, and Z. Now I know my ABCs — next time won't you sing with me?",
    'Prerequisites: A nice singing voice.',
  ].join('\n'),
  url: 'https://en.wikipedia.org/wiki/Alphabet_song',
}

function describeFilter(p: Extract<ParsedQuery, { kind: 'filter' }>): string {
  const lvl = `${p.digit}xx`
  if (p.op === '=') return `${p.subject} courses at the ${lvl} level`
  if (p.op === '+') return `${p.subject} courses at ${lvl} and above`
  return `${p.subject} courses below the ${lvl} level`
}

export function CourseLookup() {
  const [index, setIndex] = useState<Map<string, Chunk> | null>(null)
  const [query, setQuery] = useState('')
  const [course, setCourse] = useState<ParsedCourse | null>(null)
  const [matches, setMatches] = useState<Chunk[]>([])
  const [matchHeading, setMatchHeading] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  // Course codes currently expanded inline in the subject/filter list.
  // Multi-value: opening a new block does not collapse previous ones; the
  // only way to collapse a block is to click it again. Reset to empty on
  // every new search (in lookup() below) so a fresh subject/filter query
  // starts collapsed.
  const [expandedCodes, setExpandedCodes] = useState<Set<string>>(new Set())

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
    setExpandedCodes(new Set())
    if (!index) return

    const parsed = parseQuery(raw)

    if (parsed.kind === 'none') {
      setCourse(null)
      setMatches([])
      setMatchHeading('')
      setSuggestions([])
      return
    }

    if (parsed.kind === 'invalidFilter') {
      setCourse(null)
      setMatches([])
      setMatchHeading('')
      setSuggestions([])
      setError(parsed.reason)
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
      // No exact hit. Try a prefix scan over the canonical "SUBJ 22"
      // form so partial-number queries (CPSC 2 → CPSC 200…298 + 2xxx)
      // surface as a real expandable list rather than dead-end "Did
      // you mean?" suggestions. `codes` is sorted alphabetically; for
      // mixed 3- and 4-digit numbers the lex order is fine (CPSC 220
      // before CPSC 2200, both grouped under "starting with 22").
      setCourse(null)
      const prefixHits = codes.filter((c) => c.startsWith(parsed.code))
      if (prefixHits.length > 0) {
        const prefixChunks = prefixHits
          .map((c) => index.get(c))
          .filter((c): c is Chunk => Boolean(c))
        setMatches(prefixChunks)
        setMatchHeading(`${parsed.code} courses`)
        setSuggestions([])
        return
      }
      // Last resort: substring suggestions for typos that prefix
      // matching can't reach (e.g. mistyped subject codes).
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

    // Easter egg: typing the pseudo-subject "ABCD" surfaces a single
    // synthetic course block. Intercepts before the real subject/filter
    // lookup so the "no courses found" path doesn't fire.
    if (parsed.kind === 'subject' && parsed.subject === 'ABCD') {
      setMatches([ABCD_EASTER_CHUNK])
      setMatchHeading('ABCD courses')
      setCourse(null)
      setSuggestions([])
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
        return d < digit
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
          subject, or add an operator after an X00 number:{' '}
          <span className="font-mono text-zinc-300">CPSC 100 =</span> (only 1xx),{' '}
          <span className="font-mono text-zinc-300">CPSC 200 +</span> (2xx and up),{' '}
          <span className="font-mono text-zinc-300">CPSC 200 -</span> (below 2xx).
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
              {matches.map((c) => {
                const expanded = c.code !== null && expandedCodes.has(c.code)
                // Easter chunks get a gold-tinted border so they read as
                // "found something special" without screaming. Same amber-300
                // shade used by the sidebar counter + chat ring/spark, scaled
                // back to /60 opacity so it's a hint rather than a banner.
                const isEaster = c.id.startsWith('easter:')
                const buttonStateClass = isEaster
                  ? expanded
                    ? 'border-amber-300 bg-zinc-800'
                    : 'border-amber-300/60 bg-zinc-900/60 hover:bg-zinc-800 hover:border-amber-300/80'
                  : expanded
                    ? 'border-zinc-600 bg-zinc-800'
                    : 'border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 hover:border-zinc-700'
                return (
                  <li key={c.id} className="flex flex-col gap-1.5">
                    <button
                      onClick={() => {
                        const code = c.code
                        if (code === null) return
                        const willExpand = !expandedCodes.has(code)
                        setExpandedCodes((prev) => {
                          const next = new Set(prev)
                          if (next.has(code)) next.delete(code)
                          else next.add(code)
                          return next
                        })
                        // Discovery counter ticks on the transition from
                        // collapsed → expanded only. Re-collapsing or
                        // re-expanding doesn't double-count (markDiscovered
                        // is idempotent on its own, but skipping the call on
                        // collapse keeps the intent obvious in the trace).
                        if (willExpand && isEaster) {
                          useEasterEggs.getState().markDiscovered(c.id)
                        }
                      }}
                      aria-expanded={expanded}
                      className={`w-full text-left rounded border px-3 py-2 text-sm transition-colors ${buttonStateClass}`}
                    >
                      <span className="font-mono text-zinc-100">{c.code}</span>
                      <span className="text-zinc-400"> — {c.title}</span>
                    </button>
                    {expanded && <CourseCard course={parseCourseChunk(c)} />}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {/* Standalone card for exact-match queries (e.g. "CPSC 110"). The
            subject/filter flow now expands inline above and never reaches
            here — `course` is only set by the exact branch in lookup(). */}
        {course && matches.length === 0 && <CourseCard course={course} />}
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
