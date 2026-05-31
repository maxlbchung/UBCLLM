import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  getCourseIndex,
  parseCourseChunk,
  type Chunk,
  type ParsedCourse,
} from '../lib/retrieve'
import { parseQuery, type ParsedQuery } from '../lib/courseQuery'
import { ABCD_EASTER_ID, useEasterEggs } from '../store/easterEggs'
import { playSfx } from '../lib/sfx'
import { ChevronDownIcon, ExternalLinkIcon } from './icons'

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

// parseQuery + ParsedQuery now live in lib/courseQuery.ts so the planner's
// mini-lookup can share the same code/subject/filter conventions. Imported
// at the top of this file.

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

const COURSE_LEVELS = [1, 2, 3, 4] as const
type CourseLevel = (typeof COURSE_LEVELS)[number]

// Human-readable label for the course-level filter. `4` is the open-ended
// 400+ bucket; 1–3 are the exact hundreds.
function levelLabel(level: CourseLevel): string {
  return level === 4 ? '400+ level' : `${level}00 level`
}

function selectedLevelLabel(selected: Set<CourseLevel>): string {
  const labels = COURSE_LEVELS.filter((level) => selected.has(level)).map(
    levelLabel,
  )
  if (labels.length === 0) return 'no selected levels'
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`
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
  // Course-level filter: all selected by default, with 1/2/3 = exact
  // 100/200/300 and 4 = the open-ended 400+ bucket. Narrows every result
  // branch alongside the code + keyword inputs (see `matchesLevel` in the
  // search effect).
  const [selectedLevels, setSelectedLevels] = useState<Set<CourseLevel>>(
    () => new Set(COURSE_LEVELS),
  )
  const [course, setCourse] = useState<ParsedCourse | null>(null)
  const [matches, setMatches] = useState<Chunk[]>([])
  const [matchHeading, setMatchHeading] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [codeHelpOpen, setCodeHelpOpen] = useState(false)
  const [keywordHelpOpen, setKeywordHelpOpen] = useState(false)
  const [levelMenuOpen, setLevelMenuOpen] = useState(false)
  const levelMenuRef = useRef<HTMLDivElement | null>(null)
  // Course codes currently expanded inline in the subject/filter list.
  // Multi-value: opening a new block does not collapse previous ones; the
  // only way to collapse a block is to click it again. Reset to empty on
  // every new search so a fresh subject/filter/keyword query starts
  // collapsed.
  const [expandedCodes, setExpandedCodes] = useState<Set<string>>(new Set())

  useEffect(() => {
    void getCourseIndex().then(setIndex)
  }, [])

  useEffect(() => {
    if (!levelMenuOpen) return

    function onPointerDown(e: PointerEvent) {
      const target = e.target
      if (target instanceof Node && levelMenuRef.current?.contains(target)) {
        return
      }
      setLevelMenuOpen(false)
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setLevelMenuOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [levelMenuOpen])

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
    const hasLevelFilter = selectedLevels.size !== COURSE_LEVELS.length
    const levelSummary = selectedLevelLabel(selectedLevels)
    const matchesKw = (chunk: Chunk) => {
      if (!hasKw) return true
      return searchCorpus.get(chunk.id)?.includes(kw) ?? false
    }
    // Course-level predicate. Codes are "SUBJ 110" form, so the level is
    // the first digit of the number. `4` is the open-ended 400+ bucket.
    const matchesLevel = (chunk: Chunk) => {
      const num = chunk.code?.split(' ')[1]
      if (!num) return false
      const d = Number(num[0])
      if (Number.isNaN(d)) return false
      const bucket = d >= 4 ? 4 : d
      return selectedLevels.has(bucket as CourseLevel)
    }
    const keep = (chunk: Chunk) => matchesKw(chunk) && matchesLevel(chunk)
    // Append the active levels to a result heading. The keyword part is
    // already woven into each branch's base heading, so this only adds the
    // level segment when the default all-selected state has been narrowed.
    const withLevels = (heading: string) =>
      hasLevelFilter ? `${heading} · ${levelSummary}` : heading

    const parsed = parseQuery(query)

    if (parsed.kind === 'none') {
      // No code query. A keyword and/or level filter still scans the full
      // index; with neither, clear the view entirely.
      if (!hasKw && !hasLevelFilter) {
        setCourse(null)
        setMatches([])
        setMatchHeading('')
        setSuggestions([])
        return
      }
      const allMatches: Chunk[] = []
      for (const c of index.values()) {
        if (c.id.startsWith('easter:')) continue
        if (keep(c)) allMatches.push(c)
      }
      setCourse(null)
      setMatches(allMatches.slice(0, KEYWORD_RESULT_CAP))
      // Level-only browsing leads with the level; a keyword query keeps the
      // keyword as the base and rides the shared withLevels suffix.
      const base = hasKw
        ? withLevels(`results containing "${keyword.trim()}"`)
        : `${levelSummary} courses`
      setMatchHeading(
        allMatches.length > KEYWORD_RESULT_CAP
          ? `${base} (showing first ${KEYWORD_RESULT_CAP} of ${allMatches.length.toLocaleString()})`
          : base,
      )
      setSuggestions([])
      if (allMatches.length === 0) {
        setError(
          hasKw
            ? `No courses match keyword "${keyword.trim()}"${hasLevelFilter ? ` at ${levelSummary}` : ''}.`
            : selectedLevels.size === 0
              ? 'Select at least one level to browse courses.'
              : `No courses at ${levelSummary}.`,
        )
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
        if (!matchesLevel(chunk)) {
          setCourse(null)
          setMatches([])
          setMatchHeading('')
          setSuggestions([])
          setError(
            selectedLevels.size === 0
              ? 'Select at least one level to search courses.'
              : `${parsed.code} isn't in ${levelSummary}.`,
          )
          return
        }
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
          .filter(keep)
        if (prefixChunks.length > 0) {
          setMatches(prefixChunks)
          setMatchHeading(
            withLevels(
              hasKw
                ? `${parsed.code} courses matching "${keyword.trim()}"`
                : `${parsed.code} courses`,
            ),
          )
          setSuggestions([])
          return
        }
        if (hasKw || hasLevelFilter) {
          setMatches([])
          setMatchHeading('')
          setSuggestions([])
          setError(
            hasKw
              ? `No ${parsed.code} courses mention "${keyword.trim()}"${hasLevelFilter ? ` at ${levelSummary}` : ''}.`
              : selectedLevels.size === 0
                ? 'Select at least one level to search courses.'
                : `No ${parsed.code} courses at ${levelSummary}.`,
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
      .filter(keep)

    const baseHeading =
      parsed.kind === 'filter'
        ? describeFilter(parsed)
        : usedLoosePrefix
          ? `Courses starting with "${parsed.subject}"`
          : `${parsed.subject} courses`

    const headingWithKw = hasKw
      ? `${baseHeading} containing "${keyword.trim()}"`
      : baseHeading

    setMatches(chunks)
    setMatchHeading(withLevels(headingWithKw))
    setCourse(null)
    setSuggestions([])
    if (chunks.length === 0) {
      setError(
        hasKw
          ? `No ${baseHeading.toLowerCase()} mention "${keyword.trim()}"${hasLevelFilter ? ` at ${levelSummary}` : ''}.`
          : hasLevelFilter
            ? selectedLevels.size === 0
              ? 'Select at least one level to search courses.'
              : `No ${baseHeading.toLowerCase()} at ${levelSummary}.`
            : parsed.kind === 'filter'
              ? `No ${describeFilter(parsed)}.`
              : `No courses found for subject "${parsed.subject}".`,
      )
    }
  }, [query, keyword, selectedLevels, index, codes, searchCorpus])

  if (!index) {
    return <div className="p-6 text-fg-faint">Loading course index…</div>
  }

  return (
    <div className="flex flex-col h-screen p-6 gap-4 max-w-3xl mx-auto w-full min-h-0">
      <header>
        <h2 className="text-xl font-semibold">Course Finder</h2>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm text-fg-muted">
          <p>{codes.length.toLocaleString()} courses · UBC Vancouver</p>
        </div>
      </header>

      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <div className="relative flex-1">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            placeholder="Course Code Search"
            className="w-full rounded bg-input border border-line-soft text-fg pl-3 pr-9 py-2 text-sm focus:outline-none focus:border-fg-faint"
          />
          <button
            type="button"
            aria-label="Course code search syntax"
            onClick={() => { setCodeHelpOpen((v) => !v); setKeywordHelpOpen(false) }}
            className={`absolute right-2 top-1/2 -translate-y-1/2 select-none w-5 h-5 rounded-full border text-xs leading-none flex items-center justify-center transition-colors ${
              codeHelpOpen
                ? 'border-fg-muted text-fg bg-surface-raised'
                : 'border-fg-faint text-fg-muted hover:text-fg hover:border-fg-muted'
            }`}
          >
            ?
          </button>
        </div>
        <div className="relative flex-1">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="Keyword Search"
            className="w-full rounded bg-input border border-line-soft text-fg pl-3 pr-9 py-2 text-sm focus:outline-none focus:border-fg-faint"
          />
          <button
            type="button"
            aria-label="Keyword search help"
            onClick={() => { setKeywordHelpOpen((v) => !v); setCodeHelpOpen(false) }}
            className={`absolute right-2 top-1/2 -translate-y-1/2 select-none w-5 h-5 rounded-full border text-xs leading-none flex items-center justify-center transition-colors ${
              keywordHelpOpen
                ? 'border-fg-muted text-fg bg-surface-raised'
                : 'border-fg-faint text-fg-muted hover:text-fg hover:border-fg-muted'
            }`}
          >
            ?
          </button>
        </div>
        <div
          ref={levelMenuRef}
          className="relative shrink-0"
        >
          <button
            type="button"
            aria-haspopup="true"
            aria-expanded={levelMenuOpen}
            aria-label="Filter by course level"
            title="Filters"
            onClick={() => {
              setLevelMenuOpen((open) => !open)
              playSfx(levelMenuOpen ? 'collapse' : 'expand')
            }}
            className={`flex w-24 items-center justify-between gap-2 rounded border bg-input px-3 py-2 text-sm text-fg transition-colors focus:outline-none ${
              levelMenuOpen
                ? 'border-fg-faint'
                : 'border-line-soft hover:border-fg-faint'
            }`}
          >
            <span>Filters</span>
            <ChevronDownIcon
              className={`h-4 w-4 text-fg-muted transition-transform ${
                levelMenuOpen ? 'rotate-180' : ''
              }`}
            />
          </button>
          {levelMenuOpen && (
            <fieldset className="absolute right-0 top-[calc(100%+0.25rem)] z-20 w-24 rounded border border-line-soft bg-surface p-2 shadow-lg">
              <legend className="sr-only">Filter by course level</legend>
              <div className="flex flex-col gap-1">
                {COURSE_LEVELS.map((level) => {
                  const checked = selectedLevels.has(level)
                  return (
                    <label
                      key={level}
                      className="inline-flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-sm text-fg hover:bg-surface-raised"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelectedLevels((prev) => {
                            const next = new Set(prev)
                            if (next.has(level)) next.delete(level)
                            else next.add(level)
                            return next
                          })
                          playSfx(checked ? 'toggleOff' : 'toggleOn')
                        }}
                        className="h-3.5 w-3.5 rounded border-line-soft bg-surface accent-accent"
                      />
                      <span className="tabular-nums">
                        {level === 4 ? '400+' : `${level}00`}
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
          )}
        </div>
      </div>

      {codeHelpOpen && (
        <div className="rounded border border-line-soft bg-surface px-3 py-2 text-sm text-fg-muted shadow-lg flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-4">
            <p>
              Format: <span className="font-mono text-fg">[CODE] [NUMBER]</span>
            </p>
            <div className="flex gap-1 shrink-0">
              <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">ASTR 101</span>
              <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">DSCI 100</span>
              <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">WRDS 150</span>
            </div>
          </div>
        </div>
      )}

      {keywordHelpOpen && (
        <div className="rounded border border-line-soft bg-surface px-3 py-2 text-sm text-fg-muted shadow-lg">
          <div className="flex items-center justify-between gap-4">
            <p>Search titles and descriptions by key phrases.</p>
            <div className="flex gap-1 shrink-0">
              <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">Linear Algebra</span>
              <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">Introduction</span>
              <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">Co-op</span>
            </div>
          </div>
        </div>
      )}

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
        className="inline-flex items-center gap-1 text-xs text-link hover:underline"
      >
        UBC calendar
        <ExternalLinkIcon className="w-3 h-3" />
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
