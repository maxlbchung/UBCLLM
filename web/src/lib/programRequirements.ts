// Loads UBC degree-program metadata for the Degree Planner's program
// selector + requirements panel. Reads the static scraper output at
// /data/degree_programs.json and, when present, an optional structured
// overlay at /data/program_requirements.json (Track B of the plan). When
// the overlay is absent the loader falls back to prose-mode requirements
// (referenced_courses checklist + raw text).

export interface DegreeRecord {
  url: string
  title: string
  program: string | null
  faculty: string | null
  level: 'undergraduate' | 'masters' | 'doctoral' | 'certificate' | string
  kind: string
  referenced_courses: string[]
  text: string
}

export interface CategoryOption {
  // Exact course code (e.g. "ENGL 100") OR subject_pattern (e.g. "ENGL 3"
  // = any 3xx ENGL course). One of the two must be present.
  code?: string
  subject_pattern?: string
  credit_value?: number
}

export interface RequirementCategory {
  name: string
  credits_required: number
  options: CategoryOption[]
  notes?: string
}

export interface StructuredRequirements {
  kind: 'structured'
  program_url: string
  total_credits?: number
  categories: RequirementCategory[]
}

export interface ProseRequirements {
  kind: 'prose'
  program_url: string
  text: string
  referenced_courses: string[]
}

export type ProgramRequirements = StructuredRequirements | ProseRequirements

// Faculty → list of programs (degree_overview / major / minor records grouped
// by `program` string so the user picks "BSc (Computer Science)" rather than
// raw URLs).
export interface ProgramOption {
  url: string
  title: string
  // Display label for the selector. Equals `title` for the common case;
  // disambiguated to `${title} (${program})` when two programs in the same
  // faculty share a title (e.g. Creative Writing under both BA and BFA).
  label: string
  program: string | null
  kind: string
  level: string
}

export interface ProgramIndex {
  faculties: string[]
  majorsByFaculty: Map<string, ProgramOption[]>
  minorsByFaculty: Map<string, ProgramOption[]>
  byUrl: Map<string, DegreeRecord>
}

let indexPromise: Promise<ProgramIndex> | null = null
let overlayPromise: Promise<Map<string, StructuredRequirements>> | null = null

// Policy / page-meta titles that share `kind: 'other'` with the actual
// majors UBC didn't tag explicitly (UBC's calendar has subject hubs
// titled just "Anthropology" / "Biology" mixed in with sub-pages titled
// "Introduction" / "Credit Exclusion Lists" / "Communication Requirements"
// — same kind, very different meaning). Anything matching this regex is
// dropped from the majors selector so users see discipline names, not
// policy boilerplate.
const POLICY_TITLE_RE =
  /^(introduction(\s+to\b|$)|credit[/]d[/]fail|credit at\b|credit requirements|credit exclusion|registration$|examinations?$|academic\s+(concession|leave|policies|performance|standing|advancement)|readmission|second.degree\s+studies|science\s+credit\s+exclusion|degree\s+program\s+options|recognition\s+of\s+academic|application$|communication\s+requirements?|science\s+and\s+arts\s+requirements?|science\s+breadth\s+requirement|lower.level\s+requirements?|upper.level\s+requirements?|breadth\s+requirement|outside\s+requirement|study\s+abroad|student\s+exchange|general\s+degree\s+requirements?|graduation|co.?op\b|cooperative\s+education|transfer\s+credit|advising|admission(s)?|regulations?|degree\s+requirements?|credit\s+requirements\s+and\s+regulations)/i

// Admin / boilerplate pages that carry a "real" kind (major / specialization
// / degree_overview) or sit mid-title, so POLICY_TITLE_RE's start-anchored
// pass misses them. These phrases never occur in a genuine discipline name,
// so an UNANCHORED search is safe here. Each pattern below targets one known
// leak observed in degree_programs.json:
//   - "Adding a Specialization Outside the Faculty of Arts"  (kind: specialization)
//   - "Course and Specialization Approval"                   (kind: specialization)
//   - "B.Sc. Specialization-Specific Courses Required …"     (kind: degree_overview)
//   - "Double Major and Dual Degree Options"                 (kind: major)
//   - "Program of Study Guide for students who entered …"    (kind: other)
//   - "B.Sc. Degrees for Students Who Started Prior to …"    (kind: degree_overview)
//   - "Return to Studies and Readmission" · "Degree Options" (Pharmacy hub pages)
//   - "Canadian Midwifery Regulators Consortium"             (regulatory body)
// "dual degree option" is deliberately narrow so it won't catch legit combined
// majors like LFS's "Food and Nutritional Sciences Double Major".
const ADMIN_TITLE_RE =
  /(adding\s+(a|an)\s+special|specialization[-\s]specific|specialization\s+approval|dual\s+degree\s+option|program\s+of\s+study\s+guide|students?\s+who\s+started|return\s+to\s+studies|regulators\s+consortium|^degree\s+options?$)/i

// URL-path → faculty mapping. UBC's scraped `record.faculty` is often
// wrong: many certificates filed under `/faculty-education/certificate-
// programs/...` or `/faculty-arts/...` end up tagged "Faculty of Applied
// Science" because their source-page breadcrumbs share boilerplate with
// other entries. The URL slug is the authoritative signal — every
// program lives under a `/faculty-X/...` or `/school-X/...` prefix in
// the canonical calendar layout — so we derive the faculty from that
// when the URL has a recognized prefix, and fall back to the scraped
// value otherwise.
const URL_FACULTY_PATTERNS: Array<{ slug: string; faculty: string }> = [
  { slug: '/faculty-arts/', faculty: 'The Faculty of Arts' },
  { slug: '/faculty-science/', faculty: 'The Faculty of Science' },
  {
    slug: '/faculty-applied-science/',
    faculty: 'The Faculty of Applied Science',
  },
  {
    slug: '/faculty-commerce-and-business-administration/',
    faculty: 'The Faculty of Commerce and Business Administration',
  },
  { slug: '/faculty-education/', faculty: 'The Faculty of Education' },
  {
    slug: '/faculty-forestry-and-environmental-stewardship/',
    faculty: 'The Faculty of Forestry and Environmental Stewardship',
  },
  {
    slug: '/faculty-land-and-food-systems/',
    faculty: 'The Faculty of Land and Food Systems',
  },
  { slug: '/faculty-medicine/', faculty: 'The Faculty of Medicine' },
  {
    slug: '/faculty-pharmaceutical-sciences/',
    faculty: 'The Faculty of Pharmaceutical Sciences',
  },
  {
    slug: '/school-biomedical-engineering/',
    faculty: 'The School of Biomedical Engineering',
  },
  { slug: '/school-music/', faculty: 'The School of Music' },
  {
    slug: '/school-architecture-and-landscape-architecture/',
    faculty: 'The School of Architecture and Landscape Architecture',
  },
  {
    slug: '/school-population-and-public-health/',
    faculty: 'The School of Population and Public Health',
  },
  {
    slug: '/school-kinesiology/',
    faculty: 'The School of Kinesiology',
  },
  {
    slug: '/vancouver-school-economics/',
    faculty: 'The Vancouver School of Economics',
  },
  {
    slug: '/faculty-graduate-and-postdoctoral-studies/',
    faculty: 'The Faculty of Graduate and Postdoctoral Studies',
  },
]

function effectiveFaculty(r: DegreeRecord): string | null {
  for (const { slug, faculty } of URL_FACULTY_PATTERNS) {
    if (r.url.includes(slug)) return faculty
  }
  return r.faculty
}

// An umbrella degree (Bachelor of Arts / Science / Applied Science / …) is a
// container the student does NOT pick directly — they pick a major *inside*
// it. We detect one structurally: a `degree_overview` whose URL is the path
// prefix of pages that are themselves selectable majors. A page signals
// "this degree is subdivided" when it is kind `major` (explicit) or a real
// kind `other` discipline page. We require either one explicit major child
// or ≥2 discipline children, so a standalone program whose only sub-pages
// are a lone option/specialization (e.g. Bachelor of Education → "Chef
// Education Specialization", Bachelor of Computer Science → "Integrated
// Computer Science") stays selectable instead of vanishing. `honours` /
// `specialization` children are intentionally NOT counted — they're add-ons
// to a degree, not evidence the degree itself is just a container.
function buildUmbrellaDetector(
  records: DegreeRecord[],
): (degreeUrl: string) => boolean {
  const majorChildUrls: string[] = []
  const disciplineChildUrls: string[] = []
  for (const r of records) {
    const t = r.title.trim()
    if (ADMIN_TITLE_RE.test(t)) continue
    const u = r.url.replace(/\/+$/, '')
    if (r.kind === 'major') majorChildUrls.push(u)
    else if (r.kind === 'other' && !POLICY_TITLE_RE.test(t))
      disciplineChildUrls.push(u)
  }
  return (degreeUrl: string): boolean => {
    const prefix = degreeUrl.replace(/\/+$/, '') + '/'
    if (majorChildUrls.some((u) => u.startsWith(prefix))) return true
    let disciplines = 0
    for (const u of disciplineChildUrls) {
      if (u.startsWith(prefix) && ++disciplines >= 2) return true
    }
    return false
  }
}

function isMajorEligible(
  r: DegreeRecord,
  isUmbrella: (degreeUrl: string) => boolean,
): boolean {
  // Planner targets undergrad / certificate programs. Faculty buckets
  // pull in stray masters / doctoral entries (UBC's scraper sometimes
  // files cross-listed grad programs under the parent faculty), so
  // gate by level too.
  if (r.level !== 'undergraduate' && r.level !== 'certificate') return false
  // Admin / boilerplate pages leak in under "real" kinds — drop them first,
  // regardless of kind, so the selector lists programs, not procedures.
  if (ADMIN_TITLE_RE.test(r.title.trim())) return false
  if (
    r.kind === 'major' ||
    r.kind === 'honours' ||
    r.kind === 'specialization'
  ) {
    return true
  }
  if (r.kind === 'degree_overview') {
    // Keep terminal/standalone degrees (certificates, diplomas, single-
    // program bachelors like Pharmacy / Nursing / Midwifery); drop the
    // broad umbrellas whose majors are listed as separate options.
    return !isUmbrella(r.url)
  }
  if (r.kind === 'other') {
    return !POLICY_TITLE_RE.test(r.title.trim())
  }
  return false
}

// Within one faculty bucket the same discipline can appear under more than
// one parent degree (e.g. "Creative Writing" exists under both the BA and
// the BFA). Those collapse to identical dropdown labels, which reads like a
// duplicate bug. For any title that repeats in the list, append the parent
// program so each option is distinguishable; unique titles are left clean.
function disambiguateLabels(list: ProgramOption[]): void {
  const counts = new Map<string, number>()
  for (const o of list) counts.set(o.title, (counts.get(o.title) ?? 0) + 1)
  for (const o of list) {
    if ((counts.get(o.title) ?? 0) > 1 && o.program) {
      o.label = `${o.title} (${o.program})`
    }
  }
}

export function getProgramIndex(): Promise<ProgramIndex> {
  if (!indexPromise) {
    indexPromise = (async () => {
      const base = import.meta.env.BASE_URL
      const res = await fetch(`${base}data/degree_programs.json`)
      if (!res.ok) {
        throw new Error(`degree_programs.json: ${res.status}`)
      }
      const records = (await res.json()) as DegreeRecord[]
      const byUrl = new Map<string, DegreeRecord>()
      const majors = new Map<string, ProgramOption[]>()
      const minors = new Map<string, ProgramOption[]>()
      const facultySet = new Set<string>()
      const isUmbrella = buildUmbrellaDetector(records)
      for (const r of records) {
        byUrl.set(r.url, r)
        // Trust the URL over the scraped faculty field — see comment on
        // URL_FACULTY_PATTERNS for why.
        const faculty = effectiveFaculty(r)
        if (!faculty) continue
        facultySet.add(faculty)
        const opt: ProgramOption = {
          url: r.url,
          title: r.title,
          label: r.title,
          program: r.program,
          kind: r.kind,
          level: r.level,
        }
        // What goes in the Major / Program selector:
        //   - kind 'major' / 'honours' / 'specialization' — explicit
        //   - kind 'degree_overview' ONLY when it's a terminal/standalone
        //     program, not a broad umbrella (Bachelor of Arts / Science /
        //     Applied Science). See buildUmbrellaDetector — the user picks
        //     the major inside an umbrella, not the umbrella itself.
        //   - kind 'other' WHEN the title is a discipline name — many of
        //     UBC's real majors (Anthropology, Computer Science, …) land
        //     here because the scraper classifies anything missing the
        //     literal word "Major" as 'other'. We exclude the policy /
        //     meta sub-pages that share that kind (Introduction, Credit
        //     Exclusion Lists, Registration, …) via title pattern below.
        // Deliberately excluded: 'degree_requirements' (cohort-specific
        // sub-pages, not selectable programs) and 'dual_degree' (admin
        // umbrella; the user picks the underlying degree instead).
        if (isMajorEligible(r, isUmbrella)) {
          const arr = majors.get(faculty) ?? []
          arr.push(opt)
          majors.set(faculty, arr)
        }
        if (r.kind === 'minor' && !ADMIN_TITLE_RE.test(r.title.trim())) {
          const arr = minors.get(faculty) ?? []
          arr.push(opt)
          minors.set(faculty, arr)
        }
      }
      // Sort the buckets alphabetically by title, then disambiguate any
      // title that repeats within a faculty (same discipline under two
      // parent degrees) so the selector never shows two identical labels.
      for (const list of majors.values()) {
        list.sort((a, b) => a.title.localeCompare(b.title))
        disambiguateLabels(list)
      }
      for (const list of minors.values()) {
        list.sort((a, b) => a.title.localeCompare(b.title))
        disambiguateLabels(list)
      }
      return {
        faculties: Array.from(facultySet).sort(),
        majorsByFaculty: majors,
        minorsByFaculty: minors,
        byUrl,
      }
    })()
  }
  return indexPromise
}

// Optional Track B overlay. The endpoint may 404 today — that's fine; we
// return an empty map and the UI falls back to prose mode. Cached as a
// resolved promise either way so we don't re-fetch on every selection.
export function getRequirementsOverlay(): Promise<
  Map<string, StructuredRequirements>
> {
  if (!overlayPromise) {
    overlayPromise = (async () => {
      const base = import.meta.env.BASE_URL
      try {
        const res = await fetch(`${base}data/program_requirements.json`)
        if (!res.ok) return new Map()
        const json = (await res.json()) as Record<
          string,
          Omit<StructuredRequirements, 'kind'>
        >
        const out = new Map<string, StructuredRequirements>()
        for (const [url, body] of Object.entries(json)) {
          out.set(url, { kind: 'structured', ...body })
        }
        return out
      } catch {
        return new Map()
      }
    })()
  }
  return overlayPromise
}

/**
 * Look up the requirements for a selected program URL. Returns structured
 * categories when the Track B overlay has an entry for that URL, otherwise
 * falls back to prose mode (raw text + flat referenced_courses list).
 */
export async function getRequirementsFor(
  url: string,
): Promise<ProgramRequirements | null> {
  const [index, overlay] = await Promise.all([
    getProgramIndex(),
    getRequirementsOverlay(),
  ])
  const structured = overlay.get(url)
  if (structured) return structured
  const record = index.byUrl.get(url)
  if (!record) return null
  return {
    kind: 'prose',
    program_url: url,
    text: record.text,
    referenced_courses: record.referenced_courses ?? [],
  }
}

/**
 * Match a single course code against a category option. Exact code wins;
 * a subject_pattern is a literal prefix match against the canonical
 * "SUBJ NUM" form ("ENGL 3" matches "ENGL 300" through "ENGL 399").
 */
export function optionMatches(opt: CategoryOption, code: string): boolean {
  if (opt.code && opt.code === code) return true
  if (opt.subject_pattern && code.startsWith(opt.subject_pattern)) return true
  return false
}
