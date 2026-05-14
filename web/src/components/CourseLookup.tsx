import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  getCourseIndex,
  parseCourseChunk,
  type Chunk,
  type ParsedCourse,
} from '../lib/retrieve'
import { ABCD_EASTER_ID, useEasterEggs } from '../store/easterEggs'
import { playSfx } from '../lib/sfx'

// Wrap every (case-insensitive) occurrence of `keyword` inside `text` with a
// <mark> so the keyword filter's match site is visible in the title /
// description. Only title + description are highlighted because those are
// the only fields the filter actually scans (see `searchCorpus`); marking
// hits in Credits / Prerequisites would imply they drove the match when
// they didn't.
function highlightKeyword(text: string, keyword: string): ReactNode {
  const kw = keyword.trim()
  if (!kw) return text
  const lower = text.toLowerCase()
  const target = kw.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let hit = lower.indexOf(target, cursor)
  let key = 0
  while (hit !== -1) {
    if (hit > cursor) parts.push(text.slice(cursor, hit))
    parts.push(
      <mark
        key={key++}
        className="bg-highlight-soft text-fg rounded-sm px-0.5"
      >
        {text.slice(hit, hit + target.length)}
      </mark>,
    )
    cursor = hit + target.length
    hit = lower.indexOf(target, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <Fragment>{parts}</Fragment>
}

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

  // Subject regex accepts 1–5 letters so single-letter inputs ("C") route
  // into the subject branch and ride the loose-prefix fallback there
  // ("courses starting with C"). Without this, "C" falls through to
  // parseQuery's `none` branch and — when a keyword filter is active —
  // gets interpreted as a keyword-only scan, which surfaces every course
  // whose title or description contains the letter "c" (e.g. BAIT/ECON
  // courses mentioning "computing"). Routing to subject keeps the code
  // field anchored to code-prefix matching at all input lengths.
  const subjectMatch = q.match(/^([A-Z]{1,5})(?:_V)?$/)
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
    'Prerequisites: A nice singing voice ;)',
  ].join('\n'),
  url: 'https://en.wikipedia.org/wiki/Alphabet_song',
}

function describeFilter(p: Extract<ParsedQuery, { kind: 'filter' }>): string {
  const lvl = `${p.digit}xx`
  if (p.op === '=') return `${p.subject} courses at the ${lvl} level`
  if (p.op === '+') return `${p.subject} courses at ${lvl} and above`
  return `${p.subject} courses below the ${lvl} level`
}

// Cap on keyword-only result sets. The corpus has ~9,450 courses; a generic
// keyword like "the" would render every chunk into the DOM and freeze the
// browser. 200 leaves enough room for sharper queries to land their full
// hit list while preventing pathological cases.
const KEYWORD_RESULT_CAP = 200

export function CourseLookup() {
  const [index, setIndex] = useState<Map<string, Chunk> | null>(null)
  const [query, setQuery] = useState('')
  const [keyword, setKeyword] = useState('')
  const [course, setCourse] = useState<ParsedCourse | null>(null)
  const [matches, setMatches] = useState<Chunk[]>([])
  const [matchHeading, setMatchHeading] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  // Course codes currently expanded inline in the subject/filter list.
  // Multi-value: opening a new block does not collapse previous ones; the
  // only way to collapse a block is to click it again. Reset to empty on
  // every new search so a fresh subject/filter/keyword query starts
  // collapsed.
  const [expandedCodes, setExpandedCodes] = useState<Set<string>>(new Set())

  useEffect(() => {
    void getCourseIndex().then(setIndex)
  }, [])

  const codes = useMemo(
    () => (index ? Array.from(index.keys()).sort() : []),
    [index],
  )

  // Per-chunk lowercase haystack of (title + description) for the keyword
  // filter. Built once per index load (~9,450 parseCourseChunk calls, well
  // under 100 ms) so the keystroke-by-keystroke filter is just substring
  // match against a Map. Easter chunks are excluded so keyword search
  // can't surface them as spoilers — they still ride their dedicated
  // discovery paths.
  const searchCorpus = useMemo(() => {
    const out = new Map<string, string>()
    if (!index) return out
    for (const chunk of index.values()) {
      if (chunk.id.startsWith('easter:')) continue
      const parsed = parseCourseChunk(chunk)
      out.set(
        chunk.id,
        `${parsed.title} ${parsed.description}`.toLowerCase(),
      )
    }
    return out
  }, [index])

  // Drive the search off both inputs. Either field changing re-runs the
  // pipeline: code query → candidate set, then keyword filter on top. Empty
  // code + non-empty keyword scans the entire corpus (capped at
  // KEYWORD_RESULT_CAP). Both empty clears the view.
  useEffect(() => {
    if (!index) return
    setError(null)
    setExpandedCodes(new Set())

    const kw = keyword.trim().toLowerCase()
    const hasKw = kw.length > 0
    const matchesKw = (chunk: Chunk) => {
      if (!hasKw) return true
      return searchCorpus.get(chunk.id)?.includes(kw) ?? false
    }

    const parsed = parseQuery(query)

    if (parsed.kind === 'none') {
      // No code query. Keyword-only mode scans the full index; otherwise
      // clear the view entirely.
      if (!hasKw) {
        setCourse(null)
        setMatches([])
        setMatchHeading('')
        setSuggestions([])
        return
      }
      const allMatches: Chunk[] = []
      for (const c of index.values()) {
        if (c.id.startsWith('easter:')) continue
        if (matchesKw(c)) allMatches.push(c)
      }
      setCourse(null)
      setMatches(allMatches.slice(0, KEYWORD_RESULT_CAP))
      setMatchHeading(
        allMatches.length > KEYWORD_RESULT_CAP
          ? `Keyword "${keyword.trim()}" (showing first ${KEYWORD_RESULT_CAP} of ${allMatches.length.toLocaleString()})`
          : `Keyword "${keyword.trim()}"`,
      )
      setSuggestions([])
      if (allMatches.length === 0) {
        setError(`No courses match keyword "${keyword.trim()}".`)
      }
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
        if (!matchesKw(chunk)) {
          setCourse(null)
          setMatches([])
          setMatchHeading('')
          setSuggestions([])
          setError(
            `${parsed.code} doesn't mention "${keyword.trim()}" in its title or description.`,
          )
          return
        }
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
          .filter(matchesKw)
        if (prefixChunks.length > 0) {
          setMatches(prefixChunks)
          setMatchHeading(
            hasKw
              ? `${parsed.code} courses matching "${keyword.trim()}"`
              : `${parsed.code} courses`,
          )
          setSuggestions([])
          return
        }
        if (hasKw) {
          setMatches([])
          setMatchHeading('')
          setSuggestions([])
          setError(
            `No ${parsed.code} courses mention "${keyword.trim()}".`,
          )
          return
        }
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
      if (matched.length === 0) setError(`No course matches "${query}".`)
      return
    }

    // Easter egg: typing the pseudo-subject "ABCD" surfaces a single
    // synthetic course block. Intercepts before the real subject/filter
    // lookup so the "no courses found" path doesn't fire. Keyword filter
    // is intentionally bypassed — the easter chunk itself isn't in
    // searchCorpus, and "ABCD" is the only path that should reveal it.
    if (parsed.kind === 'subject' && parsed.subject === 'ABCD') {
      setMatches([ABCD_EASTER_CHUNK])
      setMatchHeading('ABCD courses')
      setCourse(null)
      setSuggestions([])
      return
    }

    // subject or filter — both produce a list of matching courses.
    // Strict prefix uses the trailing space so "CPSC" only matches CPSC
    // courses, not e.g. CPSCY (if it existed). When the strict pass turns
    // up nothing for a plain subject query, fall back to a loose prefix
    // so partial codes like "CPS" still expand into CPSC (and any other
    // subject whose code starts with "CPS") — the same "possible courses"
    // affordance the exact-branch already gives partial numbers like
    // "CPSC 22". Filter queries (with the X00 + operator suffix) skip
    // this fallback because the operator only makes sense once a real
    // subject is anchored.
    const strictPrefix = `${parsed.subject} `
    let codesForSubject = codes.filter((c) => c.startsWith(strictPrefix))
    let usedLoosePrefix = false
    if (parsed.kind === 'subject' && codesForSubject.length === 0) {
      codesForSubject = codes.filter((c) => c.startsWith(parsed.subject))
      usedLoosePrefix = codesForSubject.length > 0
    }
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
      .filter(matchesKw)

    const baseHeading =
      parsed.kind === 'filter'
        ? describeFilter(parsed)
        : usedLoosePrefix
          ? `Courses starting with "${parsed.subject}"`
          : `${parsed.subject} courses`

    setMatches(chunks)
    setMatchHeading(
      hasKw ? `${baseHeading} containing "${keyword.trim()}"` : baseHeading,
    )
    setCourse(null)
    setSuggestions([])
    if (chunks.length === 0) {
      setError(
        hasKw
          ? `No ${baseHeading.toLowerCase()} mention "${keyword.trim()}".`
          : parsed.kind === 'filter'
            ? `No ${describeFilter(parsed)}.`
            : `No courses found for subject "${parsed.subject}".`,
      )
    }
  }, [query, keyword, index, codes, searchCorpus])

  if (!index) {
    return <div className="p-6 text-fg-faint">Loading course index…</div>
  }

  return (
    <div className="flex flex-col h-screen p-6 gap-4 max-w-3xl mx-auto w-full min-h-0">
      <header>
        <h2 className="text-xl font-semibold">Course Lookup</h2>
        <p className="text-sm text-fg-muted">
          {codes.length.toLocaleString()} courses · UBC Vancouver
        </p>
      </header>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            placeholder="Course Code Search"
            className="w-full rounded bg-input border border-line-soft text-fg pl-3 pr-9 py-2 text-sm focus:outline-none focus:border-fg-faint"
          />
          {/* Help affordance: hovering the `?` reveals the syntax cheat-sheet
              that previously lived in the header. The wrapper carries the
              `group` class so the popup is a `group-hover` sibling — the
              popup is a descendant of the group so moving the cursor onto
              the popup keeps the parent's :hover state active and prevents
              flicker. */}
          <div className="group absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
            <span
              aria-label="Course code search syntax"
              className="cursor-help select-none w-5 h-5 rounded-full border border-fg-faint text-fg-muted group-hover:text-fg group-hover:border-fg-muted flex items-center justify-center text-xs leading-none"
            >
              ?
            </span>
            <div
              role="tooltip"
              className="hidden group-hover:block absolute right-0 top-full mt-2 w-80 z-20 rounded border border-line-soft bg-surface p-3 text-sm text-fg-muted leading-relaxed shadow-lg"
            >
              <p>
                Search course codes using this format:{' '}
                <span className="font-mono text-fg">[CODE] [NUMBER]</span>
              </p>
              <p className="mt-2 text-xs text-fg-faint">Ex:</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                  ASTR 101
                </span>
                <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                  DSCI 100
                </span>
                <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                  WRDS 150
                </span>
              </div>
              <p className="mt-3">
                Filter by course level using this format:{' '}
                <span className="font-mono text-fg">[CODE] [NUMBER] [+/-/=]</span>
              </p>
              <p className="mt-2 text-xs text-fg-faint">Ex:</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                  SCIE 100 +
                </span>
                <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                  PHIL 400 =
                </span>
                <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                  MATH 200 -
                </span>
              </div>
            </div>
          </div>
        </div>
        <div className="relative flex-1">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="Keyword Search"
            className="w-full rounded bg-input border border-line-soft text-fg pl-3 pr-9 py-2 text-sm focus:outline-none focus:border-fg-faint"
          />
          <div className="group absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
            <span
              aria-label="Keyword search help"
              className="cursor-help select-none w-5 h-5 rounded-full border border-fg-faint text-fg-muted group-hover:text-fg group-hover:border-fg-muted flex items-center justify-center text-xs leading-none"
            >
              ?
            </span>
            <div
              role="tooltip"
              className="hidden group-hover:block absolute right-0 top-full mt-2 w-80 z-20 rounded border border-line-soft bg-surface p-3 text-sm text-fg-muted leading-relaxed shadow-lg"
            >
              <p>Search course titles and descriptions using key phrases.</p>
              <p className="mt-2 text-xs text-fg-faint">Ex:</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                  Linear Algebra
                </span>
                <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                  Introduction
                </span>
                <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                  Co-op
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-danger-fg">{error}</p>}

      {suggestions.length > 0 && (
        <div className="text-sm text-fg-muted">
          <p className="mb-1">Did you mean:</p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => {
                  playSfx('click')
                  setQuery(s)
                }}
                className="rounded bg-surface-raised hover:bg-line-soft text-fg px-2 py-1 text-xs"
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
            <p className="text-xs text-fg-faint">
              {matches.length.toLocaleString()} {matchHeading}
            </p>
            <ul className="flex flex-col gap-1">
              {matches.map((c) => {
                const expanded = c.code !== null && expandedCodes.has(c.code)
                // Easter chunks get a gold-tinted border so they read as
                // "found something special" without screaming. Same highlight
                // shade used by the sidebar counter + chat ring/spark, scaled
                // back to /60 opacity so it's a hint rather than a banner.
                const isEaster = c.id.startsWith('easter:')
                const buttonStateClass = isEaster
                  ? expanded
                    ? 'border-highlight-fg bg-surface-raised'
                    : 'border-highlight-fg/60 bg-surface-soft hover:bg-surface-raised hover:border-highlight-fg/80'
                  : expanded
                    ? 'border-fg-faint bg-surface-raised'
                    : 'border-line bg-surface-soft hover:bg-surface-raised hover:border-line-soft'
                return (
                  <li key={c.id} className="flex flex-col gap-1.5">
                    <button
                      onClick={() => {
                        const code = c.code
                        if (code === null) return
                        const willExpand = !expandedCodes.has(code)
                        playSfx(willExpand ? 'courseExpand' : 'courseCollapse')
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
                      <span className="font-mono text-fg">{c.code}</span>
                      <span className="text-fg-muted">
                        {' — '}
                        {highlightKeyword(c.title, keyword)}
                      </span>
                    </button>
                    {expanded && (
                      <CourseCard
                        course={parseCourseChunk(c)}
                        keyword={keyword}
                        hideHeader
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {/* Standalone card for exact-match queries (e.g. "CPSC 110"). The
            subject/filter flow now expands inline above and never reaches
            here — `course` is only set by the exact branch in lookup(). */}
        {course && matches.length === 0 && (
          <CourseCard course={course} keyword={keyword} />
        )}
      </div>
    </div>
  )
}

function CourseCard({
  course,
  keyword = '',
  hideHeader = false,
}: {
  course: ParsedCourse
  keyword?: string
  // When the card sits directly below a list button (the inline-expand
  // flow), that button already shows the code + title at heading size, so
  // repeating them here would just duplicate the row. Standalone exact-
  // match cards keep the header since nothing else identifies them.
  hideHeader?: boolean
}) {
  const fields: { label: string; value: string | undefined }[] = [
    { label: 'Credits', value: course.credits },
    { label: 'Prerequisites', value: course.prerequisites },
    { label: 'Corequisites', value: course.corequisites },
    { label: 'Equivalency', value: course.equivalency },
    { label: 'Recommended', value: course.recommended },
  ]
  return (
    <article className="rounded border border-line bg-surface-soft p-4 space-y-3">
      {!hideHeader && (
        <h3 className="text-lg font-semibold">
          {course.code}{' '}
          <span className="text-fg-muted">
            — {highlightKeyword(course.title, keyword)}
          </span>
        </h3>
      )}

      {course.description && (
        <p className="text-sm text-fg leading-relaxed">
          {highlightKeyword(course.description, keyword)}
        </p>
      )}

      <a
        href={course.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-xs text-link hover:underline"
      >
        UBC calendar ↗
      </a>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm">
        {fields
          .filter((f) => f.value)
          .map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-fg-faint">{f.label}</dt>
              <dd className="text-fg">{f.value}</dd>
            </div>
          ))}
      </dl>
    </article>
  )
}
