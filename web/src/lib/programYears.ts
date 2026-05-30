// Parses the year-by-year "Specialization Requirements" tables embedded in a
// degree program's scraped page text into a structured per-year checklist.
//
// The UBC calendar renders these as HTML tables; the scraper flattens them to
// alternating lines — a requirement label followed by its credit value:
//
//   First Year
//   CPSC_V 103
//   3
//   MATH_V 100 (or 180 or 120 or 110) 1
//   3
//   Additional Communications Requirement 2
//   3
//   Electives 1
//   12
//   Total Credits
//   30
//   Second Year
//   ...
//   Total Credits for Degree
//   120
//
// We group by year header, pair each label with the bare number that follows,
// and classify each row as a checkable course requirement (one or more course
// codes, "one of" vs "all of") or a text-only note (Electives, "Any upper
// level MATH/STAT…", a depth requirement). Text rows are shown but never count
// toward progress. Rows that don't parse to a year table at all yield an empty
// result so the caller can fall back to the flat referenced-courses list.

export type RequirementMode = 'oneof' | 'all'

export interface YearRequirement {
  // The raw label as shown on the calendar (footnote markers stripped).
  label: string
  // 'course' rows are checkable; 'text' rows are advisory only.
  kind: 'course' | 'text'
  mode: RequirementMode
  // Canonical "SUBJ NUM" codes referenced by this row (empty for text rows).
  codes: string[]
  // Credit value from the table (may be null if the page omitted it).
  credits: number | null
}

export interface ProgramYear {
  label: string
  items: YearRequirement[]
  // Year credit total as printed on the page ("Total Credits" row).
  totalCredits: number | null
}

export interface ParsedProgramYears {
  years: ProgramYear[]
  degreeTotalCredits: number | null
}

// Word form: "First Year", "Third and Fourth Years" (note plural), optionally
// trailing a footnote marker ("Second Year 7", "Third Year 10").
const YEAR_HEADER_RE =
  /^(first|second|third|fourth|fifth)(\s+and\s+(first|second|third|fourth|fifth))?\s+years?(\s+\d{1,2})?$/i
// Numeric form: "Year 2", "Year Two". The number here IS the label, not a
// footnote, so it is kept as-is.
const YEAR_HEADER_NUM_RE = /^year\s+(\d|one|two|three|four|five)$/i
// Bare credit value: 1-3 digits, optional single decimal (e.g. "1.5").
const CREDIT_LINE_RE = /^\d{1,3}(\.\d+)?$/
// Year subtotal vs. whole-degree total. Degree totals appear under several
// phrasings ("Total Credits for Degree", "Minimum Credits for Degree",
// "Overall four-year total credits"); anything else that says "total credits"
// is the per-year subtotal.
const DEGREE_TOTAL_RE =
  /(credits?\s+for\s+(the\s+)?degree|minimum\s+credits|overall\b.*\btotal\s+credits)/i
const YEAR_TOTAL_RE = /^total\s+credits$/i
// "one of" / "any of" / "either" / "or" all signal a pick-one group.
const ONEOF_RE = /\b(one|any|either)\s+of\b|\bor\b/i
// A course-subject token (CPSC, CPSC_V, AI) or a 3-digit course number.
const TOKEN_RE = /[A-Z]{2,4}(?:_V)?|\d{3}[A-Z]?/g
// Trailing footnote markers: " 1", " 2", " 4,5" at the end of a label. Course
// numbers are always 3 digits, so a trailing 1-2 digit run is always a marker.
const FOOTNOTE_RE = /\s+\d{1,2}(\s*,\s*\d{1,2})*$/

function isYearHeader(line: string): boolean {
  return YEAR_HEADER_RE.test(line) || YEAR_HEADER_NUM_RE.test(line)
}

// Display label for a year header. The word form may carry a trailing footnote
// number ("Second Year 7") which we strip; the numeric form ("Year 2") keeps
// its number since that's the label itself.
function yearLabel(line: string): string {
  if (YEAR_HEADER_RE.test(line)) return line.replace(/\s+\d{1,2}$/, '').trim()
  return line
}

// Expand a requirement label into canonical course codes, carrying the most
// recent subject forward across bare numbers: "DSCI_V 200, 220, 221" →
// DSCI 200 / DSCI 220 / DSCI 221; "MATH_V 100 (or 180 or 120 or 110)" →
// MATH 100 / 180 / 120 / 110.
function extractCodes(label: string): string[] {
  const codes: string[] = []
  const seen = new Set<string>()
  let subject: string | null = null
  for (const tok of label.match(TOKEN_RE) ?? []) {
    if (/^\d/.test(tok)) {
      if (subject) {
        const code = `${subject} ${tok}`
        if (!seen.has(code)) {
          seen.add(code)
          codes.push(code)
        }
      }
    } else {
      subject = tok.replace(/_V$/, '')
    }
  }
  return codes
}

// A requirement row is a "pick one" choice when it says so explicitly ("one of",
// "either", "or") OR carries multiple lettered branches "(a) … (b) …". UBC mixes
// "Either (a) … or (b) …" (has "or") with "Either (a) … (b) …" (no "or"); both are
// choices, so a lone "either" or a second "(b)/(c)" label is enough.
function isChoice(label: string): boolean {
  if (ONEOF_RE.test(label)) return true
  if (/\beither\b/i.test(label)) return true
  const branchLabels = label.match(/\([a-e]\)/gi)
  return branchLabels != null && branchLabels.length >= 2
}

// A continuation line is a later branch of the requirement above it — a bare
// branch label "(b) …" / "(c) …", optionally led by "or". These are emitted on
// their own flattened line by the scraper and must MERGE into the current row,
// not start a new one (otherwise the earlier branch's codes are lost).
const CONTINUATION_RE = /^(or\s+)?\([a-e]\)/i

function parseRequirement(rawLabel: string): YearRequirement {
  const label = rawLabel.replace(FOOTNOTE_RE, '').trim()
  const codes = extractCodes(label)
  return {
    label,
    kind: codes.length > 0 ? 'course' : 'text',
    mode: isChoice(label) ? 'oneof' : 'all',
    codes,
    credits: null,
  }
}

// Fold a continuation branch into the requirement it extends: concatenate the
// labels, union the codes (dedup, preserve order), and treat the result as a
// choice if either part is one (a multi-branch row is a pick-one).
function mergeRequirement(
  base: YearRequirement,
  next: YearRequirement,
): YearRequirement {
  const codes = [...base.codes]
  for (const c of next.codes) if (!codes.includes(c)) codes.push(c)
  const label = `${base.label} ${next.label}`.trim()
  return {
    label,
    kind: codes.length > 0 ? 'course' : base.kind === 'course' ? 'course' : 'text',
    mode: base.mode === 'oneof' || next.mode === 'oneof' || isChoice(label)
      ? 'oneof'
      : 'all',
    codes,
    credits: null,
  }
}

export function parseProgramYears(text: string): ParsedProgramYears {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const years: ProgramYear[] = []
  const seenYearLabels = new Set<string>()
  let current: ProgramYear | null = null
  let pending: YearRequirement | null = null
  let expectTotal: 'year' | 'degree' | null = null
  let degreeTotalCredits: number | null = null

  for (const line of lines) {
    if (isYearHeader(line)) {
      const label = yearLabel(line)
      const key = label.toLowerCase()
      // A repeated year label means a second table (e.g. a co-op variant);
      // stop at the primary one rather than stacking duplicate years.
      if (seenYearLabels.has(key)) break
      seenYearLabels.add(key)
      current = { label, items: [], totalCredits: null }
      years.push(current)
      pending = null
      expectTotal = null
      continue
    }
    if (current === null) continue
    // A new markdown section heading ends the year tables.
    if (line.startsWith('#')) {
      current = null
      pending = null
      expectTotal = null
      continue
    }
    if (DEGREE_TOTAL_RE.test(line)) {
      expectTotal = 'degree'
      pending = null
      continue
    }
    if (YEAR_TOTAL_RE.test(line)) {
      expectTotal = 'year'
      pending = null
      continue
    }
    if (CREDIT_LINE_RE.test(line)) {
      const value = Number(line)
      if (expectTotal === 'year') current.totalCredits = value
      else if (expectTotal === 'degree') degreeTotalCredits = value
      else if (pending) {
        pending.credits = value
        current.items.push(pending)
      }
      expectTotal = null
      pending = null
      continue
    }
    // Otherwise it's a requirement label; it commits only once the credit
    // line that follows arrives (so footnote sentences, which aren't followed
    // by a bare number, get overwritten and dropped).
    const req = parseRequirement(line)
    // A bare branch label ("(b) …") continues the row above it; merge so the
    // earlier branch's codes survive and the whole thing reads as one choice.
    pending =
      pending && CONTINUATION_RE.test(line)
        ? mergeRequirement(pending, req)
        : req
  }

  return { years, degreeTotalCredits }
}

// Whether a parsed result is rich enough to render as the year view (vs.
// falling back to the flat referenced-courses list).
export function hasYearRequirements(parsed: ParsedProgramYears): boolean {
  return parsed.years.some((y) =>
    y.items.some((it) => it.kind === 'course'),
  )
}

// A course requirement is auto-satisfied by the plan when: a one-of group has
// any listed code planned; an all-of group has every code planned.
export function isRequirementMet(
  item: YearRequirement,
  plannedCodes: Set<string>,
): boolean {
  if (item.kind !== 'course' || item.codes.length === 0) return false
  return item.mode === 'oneof'
    ? item.codes.some((c) => plannedCodes.has(c))
    : item.codes.every((c) => plannedCodes.has(c))
}

// Stable key for a requirement row. Shared by the Progress checklist (to
// persist manual checks) and the Autofill action (to skip rows the user
// manually fulfilled) so both agree on the format.
export function requirementKey(
  programUrl: string,
  yearLabel: string,
  item: YearRequirement,
): string {
  return `${programUrl}::${yearLabel}::${item.label}`
}
