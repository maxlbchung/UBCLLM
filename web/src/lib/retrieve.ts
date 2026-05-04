// Loads the precomputed chunk corpus + embeddings once, then answers topK
// queries via cosine similarity (rows are L2-normalized at build time, so
// cosine = dot product).
import { embed } from './embed'

const EMBED_DIM = 384

// Minimum cosine similarity (post-boost) for a chunk to be returned by topK.
// Course-code matches get +2 from the boost below and always pass; for
// pure-semantic hits this is the floor. MiniLM-L6 puts most unrelated
// short strings around 0.0–0.2, but a few greetings like "hi" cluster
// surprisingly close to specific subjects (e.g. "hi" lands at 0.315 vs
// HINU because the model learned "hi" → "hindi" in pretraining). 0.4
// excludes those edge cases while real questions still sit at 0.5–0.7.
// Tune: raise if irrelevant chunks leak through, lower if real questions
// return empty.
const MIN_SCORE = 0.4

// When the user explicitly says "course"/"class" (incl. plurals), they
// want a course chunk, not a program/faculty page. Independent of the
// course-code +2 boost (which fires on a literal CPSC 110 in the query)
// and the program +1 boost (which lifts opposite-kind chunks), so all
// three stack additively without conflict. See the boost block in topK.
const COURSE_KEYWORD_RE = /\b(course|courses|class|classes)\b/i

// Allowlist of query terms that identify a UBC program. Doubles as both
// (a) the gate for Mode B (program-only retrieval) and (b) a fallback
// title-match source for the +1 program boost when the alias key itself
// doesn't appear in the program title.
//
// Each entry maps a query-side token (matched word-boundary, case-
// insensitive against the original query) to keyword(s) that DO appear
// in matching program titles. Multi-word values like "data science"
// substring-match titles directly.
//
// Four flavours of entry:
//   - Subject codes whose 4-letter prefix isn't in the program title
//     (CPSC → computer, DSCI → data science, COGS → cognitive, KIN, LFS).
//   - Subject codes whose prefix DOES substring-match the program title
//     (ASTR, BIOL, MATH, PHYS, …). They'd already fire the +1 boost via
//     the generic ≥4-char token match below, but the alias-only Mode B
//     gate needs an explicit ALIASES entry to fire — listing them here
//     opts them into Mode B.
//   - Natural-name aliases (astronomy, biology, mathematics, …). Required
//     because the alias key is matched verbatim against the query, so a
//     user typing "tell me about astronomy" needs "astronomy" as a key
//     for Mode B to trigger; the bare subject code "ASTR" wouldn't match.
//   - Colloquial school / faculty names not in the official title
//     (Sauder = "Faculty of Commerce and Business Administration", etc.).
//
// Word-boundary regex on the original-case query, so "CPSC110", "Sauder",
// and "sauder" all trigger but a substring inside another word doesn't.
//
// Curation notes:
//   - Skipped ENGL / english, HIST / history, STAT / statistics — they're
//     extremely common as non-program words ("English language", "browser
//     history", "statistical analysis"); flipping into program-only Mode B
//     for those would surface program chunks for unrelated queries.
//   - Skipped KIN's natural-name "kinesiology" because the existing KIN
//     entry already maps to "kinesiology" as a keyword — adding a separate
//     `kinesiology: [...]` entry would just duplicate. Same logic for the
//     other already-natural aliases that read as English words.
const ALIASES: Record<string, string[]> = {
  // Subject codes whose 4-letter prefix isn't in the program title.
  CPSC: ['computer'],
  DSCI: ['data science'],
  COGS: ['cognitive'],
  LFS: ['land and food'],
  KIN: ['kinesiology'],

  // Subject codes whose prefix already substring-matches the program
  // title — listed so the alias-only Mode B gate fires when the user
  // types the code instead of the natural name.
  ASTR: ['astronomy'],
  BIOL: ['biology'],
  BIOC: ['biochemistry'],
  CHEM: ['chemistry'],
  ECON: ['economics'],
  GEOG: ['geography'],
  MATH: ['mathematics'],
  PHIL: ['philosophy'],
  PHYS: ['physics'],
  POLI: ['political science'],
  PSYC: ['psychology'],
  SOCI: ['sociology'],

  // Natural-name aliases — the query words a user is likely to type
  // when asking about a UBC program. Required so "tell me about
  // astronomy" / "what is biology" fire Mode B without forcing the
  // user to know the subject code.
  astronomy: ['astronomy'],
  biology: ['biology'],
  biochemistry: ['biochemistry'],
  chemistry: ['chemistry'],
  economics: ['economics'],
  geography: ['geography'],
  mathematics: ['mathematics'],
  math: ['mathematics'],
  philosophy: ['philosophy'],
  physics: ['physics'],
  psychology: ['psychology'],
  sociology: ['sociology'],

  // Colloquial school / faculty names not in the official title.
  Sauder: ['commerce and business'],
  VSE: ['vancouver school of economics'],
  iSchool: ['school of information'],
}

export interface Chunk {
  id: string
  // 'easter' chunks are hand-curated Q&A entries from
  // pipeline/easter-eggs.json. They share the corpus and the cosine top-K
  // with everything else, but get NO score boost — they have to win on pure
  // semantic similarity. Every existing boost in topK is gated explicitly
  // ('course'-code +2, course-keyword +1, 'program' title-match +1), so
  // easter chunks are already on a level playing field. Keep that contract:
  // any future kind-specific bonus must be opt-in by kind, not opt-out.
  kind: 'course' | 'program' | 'easter'
  code: string | null
  title: string
  text: string
  url: string
  // Set by topK on returned chunks (post-boost ranking score; cosine in
  // [-1, 1] for pure-semantic hits, ~+2 higher for course-code matches).
  // Undefined for chunks read straight from the corpus or rehydrated from
  // older persisted conversations that pre-date this field.
  score?: number
}

interface Corpus {
  chunks: Chunk[]
  matrix: Float32Array
}

let corpusPromise: Promise<Corpus> | null = null

export function loadCorpus(): Promise<Corpus> {
  if (!corpusPromise) {
    corpusPromise = (async () => {
      const base = import.meta.env.BASE_URL
      const [chunksRes, embRes] = await Promise.all([
        fetch(`${base}data/chunks.json`),
        fetch(`${base}data/embeddings.bin`),
      ])
      if (!chunksRes.ok) throw new Error(`chunks.json: ${chunksRes.status}`)
      if (!embRes.ok) throw new Error(`embeddings.bin: ${embRes.status}`)
      const chunks = (await chunksRes.json()) as Chunk[]
      const matrix = new Float32Array(await embRes.arrayBuffer())
      if (matrix.length !== chunks.length * EMBED_DIM) {
        throw new Error(
          `corpus shape mismatch: ${matrix.length} floats vs ${chunks.length} chunks * ${EMBED_DIM}`,
        )
      }
      return { chunks, matrix }
    })()
  }
  return corpusPromise
}

function dot(a: Float32Array, b: Float32Array, offset: number): number {
  let s = 0
  for (let j = 0; j < EMBED_DIM; j++) s += a[offset + j] * b[j]
  return s
}

export async function topK(
  query: string,
  k = 8,
  minScore = MIN_SCORE,
): Promise<Chunk[]> {
  const [{ chunks, matrix }, qVec] = await Promise.all([loadCorpus(), embed(query)])
  const scores = new Float32Array(chunks.length)
  for (let i = 0; i < chunks.length; i++) {
    scores[i] = dot(matrix, qVec, i * EMBED_DIM)
  }

  // Hybrid boost: course numbers are dense, low-frequency tokens that MiniLM
  // doesn't distinguish well — embed("CPSC 110") sits very close to "CPSC 121"
  // and "CPSC 320", so pure semantic top-K can miss the literal course the
  // user asked about. If the query mentions explicit course codes, push their
  // chunks above any cosine-only match. Cosine scores live in [-1, 1] after
  // normalization; +2 guarantees the boosted chunk lands in the top slice
  // (and trivially passes the minScore floor below).
  //
  // The `requested.has(c.code)` check requires an EXACT canonical code
  // ("CPSC 110") match against the chunk's code, so partial subject typos
  // can't hijack the boost: extractCourseCodes("CPS 110") yields
  // "CPS 110", which is not a real chunk code, so no chunk gets boosted.
  // Likewise "hi" extracts to nothing (regex needs both letters and
  // digits) and triggers no boost at all.
  const requested = new Set(extractCourseCodes(query))
  if (requested.size > 0) {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      if (c.kind === 'course' && c.code && requested.has(c.code)) {
        scores[i] += 2
      }
    }
  }

  // Program boost: pure-semantic ranking buries the umbrella program /
  // faculty / school overview chunk under individual courses (more chunks,
  // denser titles), so a query like "tell me about astronomy", "what is
  // CPSC", or "tell me about Sauder" shows individual course chunks before
  // the actual program/faculty page. Add +1 to any program-kind chunk
  // whose title (lowercased) contains a query token of length ≥ 4. The
  // 4-char floor avoids prepositions/articles; ALIASES handles cases where
  // the query term doesn't appear in the title (CPSC → computer, Sauder →
  // commerce and business). Magnitude is +1, deliberately under the +2
  // course-code boost so "CPSC 110 prereqs" still ranks CPSC 110 first.
  const queryLower = query.toLowerCase()
  const tokens = queryLower
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4)
  const aliasKeywords: string[] = []
  for (const [alias, keywords] of Object.entries(ALIASES)) {
    // Word-boundary match against the original query (case-insensitive)
    // so "CPSC110" still triggers (regex \b allows letter→digit boundary)
    // but "concepts" or "specifics" don't false-trigger on substring.
    if (new RegExp(`\\b${alias}\\b`, 'i').test(query)) {
      aliasKeywords.push(...keywords.map((k) => k.toLowerCase()))
    }
  }
  const programNeedles = [...tokens, ...aliasKeywords]
  if (programNeedles.length > 0) {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      if (c.kind !== 'program') continue
      const title = c.title.toLowerCase()
      if (programNeedles.some((n) => title.includes(n))) {
        scores[i] += 1
      }
    }
  }

  // Course-keyword boost: when the user says "course"/"class" (incl.
  // plurals), they want course chunks, not programs. The program boost
  // above lifts programs whose title shares generic tokens like "course"
  // or "learning" with the query (e.g. "what course should I take to
  // learn linear algebra" → "Professional and Diploma Courses",
  // "Adult Learning and Education" all jump to ~1.28). This +1 on every
  // course-kind chunk pushes the actually-relevant courses (MATH 221,
  // MATH 223, …) past those boosted programs. Stacks additively with
  // the +2 course-code boost — "what course is CPSC 110?" gives
  // CPSC 110 +3 (still wins) and other courses +1, programs nothing.
  if (COURSE_KEYWORD_RE.test(query)) {
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].kind === 'course') scores[i] += 1
    }
  }

  // Sort once by post-boost score; each retrieval mode below picks from
  // this in its own way. We don't pre-filter by minScore here because mode
  // A wants the asked courses included even if their cosine is low.
  const allIndicesByScore = Array.from(scores.keys()).sort(
    (a, b) => scores[b] - scores[a],
  )

  // ---- Mode A: course-code mode ----
  // Triggered when the query names specific course codes (CPSC 110,
  // ASTR 201, …). Two passes: (1) the asked courses themselves, then (2)
  // other course chunks whose text literally contains an asked code. Pass
  // 2 catches follow-on courses ("what's after CPSC 110" → CPSC 121, 213)
  // that list the asked code as a prereq. This sidesteps MiniLM's
  // course-code clustering blindspot — string-contains is a deterministic
  // structural signal, the way the +2 boost is for direct matches.
  if (requested.size > 0) {
    const codes = [...requested]
    const out: Chunk[] = []
    const seen = new Set<number>()
    // Pass 1: directly-asked courses (always included, even if below
    // minScore — the user named them explicitly).
    for (const i of allIndicesByScore) {
      const c = chunks[i]
      if (c.kind === 'course' && c.code && requested.has(c.code)) {
        out.push({ ...c, score: scores[i] })
        seen.add(i)
      }
    }
    // Pass 2: other courses whose chunk text mentions an asked code.
    for (const i of allIndicesByScore) {
      if (out.length >= k) break
      if (seen.has(i)) continue
      const c = chunks[i]
      if (c.kind !== 'course') continue
      if (codes.some((code) => c.text.includes(code))) {
        out.push({ ...c, score: scores[i] })
        seen.add(i)
      }
    }
    return out
  }

  // ---- Mode B: program mode ----
  // Triggered when the query names a UBC program/faculty/school via any
  // ALIASES entry — subject codes (CPSC, ASTR, BIOL, MATH, …), natural
  // names (astronomy, biology, mathematics, …), or colloquial school
  // names (Sauder, VSE, iSchool). Returns the top PROGRAM_K program
  // chunks across all matching programs by score — no course chunks, no
  // easter chunks: when the user named a program by its canonical alias,
  // they want to know what that program IS.
  //
  // The previous gate (`programNeedles.length > 0`) flipped this on for any
  // query containing a ≥4-char English token (first, year, tell, about, …),
  // which dragged unrelated queries — including easter-egg lookups — into
  // program-only mode and silently filtered out their best matches. Pure-
  // semantic program queries like "tell me about astronomy" still surface
  // programs at the top of Mode C via the +1 title-match boost above; they
  // just no longer hide course or easter chunks. Add to ALIASES when a new
  // canonical program name should opt back into Mode B's program-only slice.
  if (aliasKeywords.length > 0) {
    const PROGRAM_K = 3
    const out: Chunk[] = []
    for (const i of allIndicesByScore) {
      if (out.length >= PROGRAM_K) break
      const c = chunks[i]
      if (c.kind !== 'program') continue
      if (scores[i] < minScore) continue
      out.push({ ...c, score: scores[i] })
    }
    return out
  }

  // ---- Mode C: default semantic mode ----
  // Top-K by score with the minScore floor. For greetings and off-topic
  // queries every chunk's cosine sits near zero, so this returns [];
  // userPromptWithContext + the SCOPE rule then handle the empty case.
  return allIndicesByScore
    .filter((i) => scores[i] >= minScore)
    .slice(0, k)
    .map((i) => ({ ...chunks[i], score: scores[i] }))
}

// ---------- Course-only helpers (used by CourseLookup + PrereqTree) ----------

let courseIndexPromise: Promise<Map<string, Chunk>> | null = null

/** Map "CPSC 110" -> Chunk for every course chunk in the corpus. */
export function getCourseIndex(): Promise<Map<string, Chunk>> {
  if (!courseIndexPromise) {
    courseIndexPromise = loadCorpus().then(({ chunks }) => {
      const index = new Map<string, Chunk>()
      for (const c of chunks) {
        if (c.kind === 'course' && c.code) index.set(c.code, c)
      }
      return index
    })
  }
  return courseIndexPromise
}

export interface ParsedCourse {
  code: string
  title: string
  credits?: string
  description: string
  prerequisites?: string
  corequisites?: string
  equivalency?: string
  recommended?: string
  url: string
}

const LABEL_RE =
  /^(Credits|Prerequisites|Corequisites|Equivalency|Recommended):\s*(.*)$/

/**
 * Recover the structured course record from a chunk. The pipeline emits
 * predictable lines (see pipeline/chunk_and_embed.py:course_chunk), so we
 * parse them back out for the lookup + prereq-tree views without needing a
 * second JSON file.
 */
export function parseCourseChunk(c: Chunk): ParsedCourse {
  const lines = c.text.split('\n')
  const head = lines[0] ?? ''
  const headMatch = head.match(/^(.+?):\s*(.+)$/)
  const code = c.code ?? headMatch?.[1] ?? ''
  const title = headMatch?.[2] ?? c.title

  const out: ParsedCourse = { code, title, description: '', url: c.url }
  const desc: string[] = []
  for (const line of lines.slice(1)) {
    const m = line.match(LABEL_RE)
    if (!m) {
      desc.push(line)
      continue
    }
    const value = m[2].trim()
    switch (m[1]) {
      case 'Credits':
        out.credits = value
        break
      case 'Prerequisites':
        out.prerequisites = value
        break
      case 'Corequisites':
        out.corequisites = value
        break
      case 'Equivalency':
        out.equivalency = value
        break
      case 'Recommended':
        out.recommended = value
        break
    }
  }
  out.description = desc.join('\n').trim()
  return out
}

/**
 * Pull "CPSC 110"-style course codes out of free-form text (user queries or
 * prereq/coreq strings). Folds:
 *   - case ("cpsc 110", "Cpsc110", "CPSC 110")
 *   - optional Vancouver suffix ("CPSC_V 110")
 *   - optional space between subject and number ("CPSC110")
 * to the canonical "CPSC 110" form so it matches getCourseIndex() keys.
 */
export function extractCourseCodes(text: string | undefined): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(/\b([A-Z]{3,5})(?:_V)?\s*(\d{2,4}[A-Z]?)\b/gi)) {
    const code = `${m[1].toUpperCase()} ${m[2].toUpperCase()}`
    if (!seen.has(code)) {
      seen.add(code)
      out.push(code)
    }
  }
  return out
}
