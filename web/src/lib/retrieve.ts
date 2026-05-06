// Loads the precomputed chunk corpus + embeddings once, then answers topK
// queries via cosine similarity (rows are L2-normalized at build time, so
// cosine = dot product).
import { embed } from './embed'

const EMBED_DIM = 384

// Minimum cosine similarity (post-boost) for a chunk to be returned by topK.
// Course-code matches get +2 from the boost below and always pass; for
// pure-semantic hits this is the floor. MiniLM-L6 puts most unrelated
// short strings around 0.0–0.2, and greetings like "hi" cluster surprisingly
// close to specific subjects (e.g. "hi" lands at 0.315 vs HINU because the
// model learned "hi" → "hindi" in pretraining). 0.5 excludes those edge
// cases plus weakly-aligned tangential matches (a "data science" query
// pulling 0.42-cosine stats / CS umbrella programs that aren't really
// answering the question); real on-topic questions still sit at 0.5–0.7
// raw and pass comfortably, especially with the +0.25 program-title,
// +0.1 buddy, and +0.25 course-keyword boosts on top.
// Tune: raise if irrelevant chunks leak through, lower if real questions
// return empty.
const MIN_SCORE = 0.5

// Score nudge applied to "buddy" chunks of the top-ranked program slice.
// When the #1 chunk in the corpus is a program slice (e.g.
// program:cognitive-systems:0), every other slice of that same page
// (program:cognitive-systems:1, :2, …) gets this boost — they share a
// URL and were bin-split from one scraped page, so the user's question
// is almost always partly answered by them too. The nudge is small on
// purpose: it only crosses the minScore floor for siblings that were
// already close to passing (raw cosine ≥ ~0.4 after the +0.25 program-
// title boost). It does not promote unrelated chunks; only siblings of
// an already-winning page. See the buddy-boost block in topK for the
// full rationale.
const BUDDY_BOOST = 0.1

// When the user explicitly says "course"/"class" (incl. plurals), they
// want a course chunk, not a program/faculty page. The matching `wantsCourses`
// flag in topK does three things: adds +0.25 to every course chunk so they
// outrank similarly-scored programs, suppresses the +0.25 program-title boost
// (so the umbrella program page can't dominate via the boost), and skips
// Mode B entirely (so an alias hit like "ASTR" doesn't restrict the result
// to programs/easters when the user asked for courses).
const COURSE_KEYWORD_RE = /\b(course|courses|class|classes)\b/i

// ---------- Source-block token budget ----------
//
// Qwen3.5 2B (the model `pickModelId()` selects) runs with a
// 4096-token context window in WebLLM's prebuilt config. WebLLM pre-flight
// checks numPromptTokens > contextWindowSize and throws
// ContextWindowSizeExceededError, which our streamChat does NOT recognize
// as recoverable — so an over-budget prompt surfaces as a chat error.
// To prevent that, every retrieval mode runs its candidate list through
// enforceTokenBudget at the end.
//
// Tuned down from 2200 to 1100 after a "CPSC 110" Mode A query returned
// 17 chunks (CPSC 110 is widely listed as a prereq, so Pass 2 collected
// every follow-on course). Total source tokens fit budget but inflated
// GPU prefill pressure, contributing to a "Buffer was unmapped" mapAsync
// race. Halving the budget caps Mode A at ~8-9 chunks for typical course
// chunk sizes, which is enough grounding without filling the prefill.
// Other slots: system ~30, 6-msg history ~1100, question + RESPONSE_INST
// ruction ~400 → total worst-case prefill ~2630 tokens, comfortable under
// 4096.
const SOURCE_TOKEN_BUDGET = 1100

// Conservative chars/token estimate for Qwen's BPE tokenizer on English
// calendar text. Real ratio averages ~3.5–4; using 4 keeps us on the
// over-estimate side so the budget cuts off before the model's hard limit
// kicks in. Good enough without paying the cost of running an actual
// tokenizer in the browser.
const CHARS_PER_TOKEN = 4

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
  // pipeline/easter-eggs.json. They share the corpus and the cosine
  // top-K with everything else, and ride the program-title boost when a
  // query token substring-matches the chunk's title — that's a real
  // signal of topical alignment, so the lift is earned. They do NOT
  // ride the course-keyword boost: a "course"/"class" query word tells
  // us nothing about whether a given easter is on-topic, and an
  // unconditional kind-based lift would let easters win against
  // genuinely matching course chunks for unrelated queries.
  kind: 'course' | 'program' | 'easter'
  code: string | null
  title: string
  text: string
  url: string
  // Set by topK on returned chunks (post-boost ranking score). Pure cosine
  // is in [-1, 1]; a program chunk can pick up at most +0.25 program-title
  // and +0.1 buddy (= +0.35), a course chunk at most +0.25 course-keyword,
  // so the realistic envelope is roughly [-1, 1.35]. Undefined for chunks
  // read straight from the corpus or rehydrated from older persisted
  // conversations that pre-date this field.
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

// Easter chunks are hand-curated Q&A pairs that only make sense in their
// canonical-answer slot. Two outcomes:
//   - Top-ranked chunk IS an easter → drop everything after it. The easter
//     IS the answer; additional sources just give the LLM material to
//     confabulate from or cite over the curated answer.
//   - Top-ranked chunk is NOT an easter → strip every easter chunk from the
//     remainder. Surfacing easters lower in the source list lets them bleed
//     into normal answers (the LLM might mix the curated quip into a
//     prereq lookup, or cite an off-topic egg as a "related" source).
// Mode A returns only courses (no easter chunks at all), so this only
// matters for Mode B and Mode C.
function easterCollapse(out: Chunk[]): Chunk[] {
  if (out.length === 0) return out
  if (out[0].kind === 'easter') return [out[0]]
  return out.filter((c) => c.kind !== 'easter')
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

// Cost of one chunk in the formatted sources block (see buildContext in
// prompts.ts):  [N] {text}\nSource: {url}\n\n
// The +6 covers the "[N] ", "\nSource: ", and trailing "\n\n" framing.
function chunkPromptCost(c: Chunk): number {
  return estimateTokens(c.text) + estimateTokens(c.url) + 6
}

// Trim a candidate chunk list to fit the source token budget. Walks the
// input in order (already sorted by score upstream), dropping a chunk
// when it would push over budget — but always keeps the top-ranked chunk
// even if it solo-exceeds budget, since losing it to the "no sources
// found" path is worse grounding than sending one oversized chunk.
function enforceTokenBudget(chunks: Chunk[]): Chunk[] {
  const out: Chunk[] = []
  let tokensUsed = 0
  for (const c of chunks) {
    const cost = chunkPromptCost(c)
    if (out.length > 0 && tokensUsed + cost > SOURCE_TOKEN_BUDGET) break
    out.push(c)
    tokensUsed += cost
  }
  return out
}

export async function topK(
  query: string,
  minScore = MIN_SCORE,
): Promise<Chunk[]> {
  const [{ chunks, matrix }, qVec] = await Promise.all([loadCorpus(), embed(query)])
  const scores = new Float32Array(chunks.length)
  for (let i = 0; i < chunks.length; i++) {
    scores[i] = dot(matrix, qVec, i * EMBED_DIM)
  }

  // Course-keyword cancels program-mode behaviour. When the user explicitly
  // says "course"/"class" they want individual course chunks, so we suppress
  // both the program-title +0.5 boost (which would lift the umbrella program
  // page over the courses) and Mode B (which restricts the result to
  // program/easter chunks only). A query like "what are some ASTR courses?"
  // alias-fires on ASTR but the user's intent is course chunks, so the
  // alias-driven program-mode behaviour gets cancelled out.
  const wantsCourses = COURSE_KEYWORD_RE.test(query)

  // Course-code recognition. Used by Mode A below to structurally include
  // the asked course (Pass 1) and any chunk whose text mentions the asked
  // code (Pass 2) — both regardless of cosine score. Previously this also
  // applied a +2 score boost to the Pass 1 chunks, but that boost only
  // affected the displayed score: Pass 1 already includes asked courses
  // unconditionally and Pass 2 doesn't see the boost, so removing it makes
  // the displayed score honestly reflect cosine similarity. The
  // `requested.has(c.code)` check stays canonical-only — extractCourseCodes
  // ("CPS 110") yields "CPS 110" which isn't a real chunk code, so partial
  // subject typos can't hijack inclusion. "hi" extracts nothing (regex
  // needs both letters and digits).
  const requested = new Set(extractCourseCodes(query))

  // Program / easter boost: pure-semantic ranking buries the umbrella
  // program / faculty / school overview chunk under individual courses
  // (more chunks, denser titles), so a query like "tell me about astronomy",
  // "what is CPSC", or "tell me about Sauder" shows individual course chunks
  // before the actual program/faculty page. Add +0.25 to any program OR
  // easter chunk whose title (lowercased) contains a query token of length ≥ 4.
  // Easter chunks share this boost so the hand-curated Q&A entries can
  // compete on equal terms when their title aligns with the query — they're
  // not boosted as a kind, they're boosted on the same title-match signal
  // that lifts program pages. The 4-char floor avoids prepositions /
  // articles; ALIASES handles cases where the query term doesn't appear in
  // the title (CPSC → computer, Sauder → commerce and business).
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
  if (programNeedles.length > 0 && !wantsCourses) {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      // Boost programs only — easter chunks intentionally do NOT receive
      // the title-match lift. Easters are hand-curated Q&A entries; if
      // they win, they should win on raw cosine alignment to the user's
      // exact phrasing, not on shared topic keywords. With +0.25 (down
      // from +0.5) on programs, an off-target query like "tell me about
      // data science" leaves the easter at raw 0.55 vs the top program
      // at 0.44 + 0.25 = 0.69, so the program wins; a targeted query
      // like "who is the best data science professor" puts the easter
      // at raw 0.83 vs the top program at ~0.65, so the easter wins
      // and easterCollapse fires.
      if (c.kind !== 'program') continue
      const title = c.title.toLowerCase()
      if (programNeedles.some((n) => title.includes(n))) {
        scores[i] += 0.25
      }
    }
  }

  // Course-keyword boost: when the user says "course"/"class" (incl.
  // plurals), they want course chunks, not programs. The program boost
  // above lifts programs whose title shares generic tokens like "course"
  // or "learning" with the query (e.g. "what course should I take to
  // learn linear algebra" → "Professional and Diploma Courses",
  // "Adult Learning and Education" all jump). This boost on every course
  // chunk nudges them past the boosted programs. Easter chunks
  // deliberately do NOT ride along here — a hand-curated Q&A entry
  // should win on its own title/topic match (via the program-title
  // boost above when the alignment is real), not get a generic course-
  // word lift that doesn't reflect any signal about whether the easter
  // is actually on-topic for the query.
  if (wantsCourses) {
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].kind === 'course') scores[i] += 0.25
    }
  }

  // Easter floor: an easter chunk only earns a slot when its raw
  // cosine clears 0.75 — strong on-topic alignment, not just shared
  // keywords. Easters no longer receive the program-title boost (see
  // the boost block above), so score == raw cosine for an easter and
  // this floor lives in raw-cosine space. The two reference cases:
  //   "tell me about data science" → easter raw 0.55 → rejected ✓
  //   "who is the best data science professor" → easter raw 0.83 →
  //     passes, ranks #1, easterCollapse fires ✓
  // Raised from 0.7 to 0.75 to suppress mid-strength matches where the
  // egg's phrasing partly overlaps a generic query but isn't really the
  // canonical answer (e.g. an "astronomy professor" egg firing on a
  // bare "astronomy" query without the "who is" prefix).
  // Setting rejected easters to -Infinity drops them below minScore
  // in every downstream mode.
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].kind === 'easter' && scores[i] <= 0.75) {
      scores[i] = -Infinity
    }
  }

  // Sort once by post-boost score; each retrieval mode below picks from
  // this in its own way. We don't pre-filter by minScore here because mode
  // A wants the asked courses included even if their cosine is low.
  const allIndicesByScore = Array.from(scores.keys()).sort(
    (a, b) => scores[b] - scores[a],
  )

  // ---------- Buddy boost ----------
  // Programs are scraped as a single page then bin-split into multiple
  // slices (program:cognitive-systems:0, :1, :2, …) — they share a URL
  // because they're sub-sections of the same canonical page. When one
  // slice wins the corpus-wide #1 spot, the rest of that page often has
  // additional context the user wants but sits just below the minScore
  // floor. The motivating case: "what is cogs?" puts slice :0 (the
  // definitional opener) at the top with raw 0.458 + 0.25 program-title
  // = 0.708, but slice :1 (the required-courses list) lands at raw 0.166
  // + 0.25 = 0.416, just under the 0.5 floor — even though it answers
  // "what courses does COGS require" which a user asking "what is cogs?"
  // very plausibly also wants.
  //
  // The fix: if and only if the #1 chunk in the corpus is a program
  // slice that already cleared minScore (so we know this is a real,
  // confident match — not a greeting query where every chunk is near
  // zero), give every other program slice with the same URL a +0.1
  // bump. The nudge is small on purpose: it only crosses the floor for
  // siblings already close to passing (post-program-title score ≥ 0.4).
  // It doesn't promote unrelated chunks; the URL-equality gate scopes
  // it strictly to the winning page.
  //
  // Scope: program kind only. Course chunks share a URL across an
  // entire subject (every CPSC course points at /course-descriptions/
  // subject/cpscv) so URL-grouping wouldn't mean "same page" for them
  // — buddy-boosting all CPSC courses when one wins would be wildly
  // over-inclusive. Easters are single-slice. Mode A is course-code-
  // structural (Pass 2 already covers cross-course context) and ignores
  // these scores anyway.
  if (allIndicesByScore.length > 0) {
    const topIdx = allIndicesByScore[0]
    const topChunk = chunks[topIdx]
    if (topChunk.kind === 'program' && scores[topIdx] >= minScore) {
      const topUrl = topChunk.url
      for (let i = 0; i < chunks.length; i++) {
        if (i === topIdx) continue
        const c = chunks[i]
        if (c.kind === 'program' && c.url === topUrl) {
          scores[i] += BUDDY_BOOST
        }
      }
      allIndicesByScore.sort((a, b) => scores[b] - scores[a])
    }
  }

  // ---- Mode A: course-code mode ----
  // Triggered when the query names specific course codes (CPSC 110,
  // ASTR 201, …). Two passes: (1) the asked courses themselves, then (2)
  // other course chunks whose text literally contains an asked code. Pass
  // 2 catches follow-on courses ("what's after CPSC 110" → CPSC 121, 213)
  // that list the asked code as a prereq. This sidesteps MiniLM's
  // course-code clustering blindspot — string-contains is a deterministic
  // structural signal that doesn't need a score boost to land in the
  // result, since both passes ignore the minScore floor.
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
    // Walks the full sorted index — bounded in practice by the
    // structural string-includes filter below, and the candidate set
    // for a typical asked code is small. enforceTokenBudget trims at
    // the end if too many chunks accumulate.
    for (const i of allIndicesByScore) {
      if (seen.has(i)) continue
      const c = chunks[i]
      if (c.kind !== 'course') continue
      if (codes.some((code) => c.text.includes(code))) {
        out.push({ ...c, score: scores[i] })
        seen.add(i)
      }
    }
    return enforceTokenBudget(out)
  }

  // ---- Mode B: program / hand-curated mode ----
  // Triggered when the query names a UBC program/faculty/school via any
  // ALIASES entry — subject codes (CPSC, ASTR, BIOL, MATH, …), natural
  // names (astronomy, biology, mathematics, …), or colloquial school
  // names (Sauder, VSE, iSchool). Returns up to PROGRAM_K program OR
  // easter chunks across all matching scores — course chunks are
  // excluded because the user named a program, not a specific course.
  //
  // Easter chunks ride alongside programs here so a query like "who is
  // the best astronomy professor?" — which alias-fires on "astronomy"
  // and would otherwise return only astronomy-program chunks — can still
  // surface the hand-curated easter answer when its score wins.
  //
  // The previous gate (`programNeedles.length > 0`) flipped this on for any
  // query containing a ≥4-char English token (first, year, tell, about, …),
  // which dragged unrelated queries — including easter-egg lookups — into
  // program-only mode and silently filtered out their best matches. Pure-
  // semantic program queries like "tell me about science" still surface
  // programs at the top of Mode C via the +1 title-match boost above; they
  // just no longer hide course or easter chunks. Add to ALIASES when a new
  // canonical program name should opt back into Mode B's program-only slice.
  //
  // Skipped when wantsCourses: the user's explicit "course"/"class" overrides
  // the alias signal, so we fall through to Mode C and let course chunks
  // (with their +0.25 boost) compete on equal footing.
  if (aliasKeywords.length > 0 && !wantsCourses) {
    const out: Chunk[] = []
    for (const i of allIndicesByScore) {
      // allIndicesByScore is sorted descending, so once we drop below
      // minScore every remaining chunk fails the gate — break instead
      // of continue. This is the loop's natural termination condition
      // now that the per-kind cap is gone.
      if (scores[i] < minScore) break
      const c = chunks[i]
      if (c.kind !== 'program' && c.kind !== 'easter') continue
      // Alias-keyword filter (mirrors Mode A's string-contains "Pass 2"):
      // only return chunks whose title or text actually mentions one of
      // the keywords that triggered Mode B — "astronomy" for the ASTR
      // alias, "computer" for CPSC, etc. Without this, a chunk titled
      // "Admission" could ride the generic "admission" needle into Mode
      // B's slots even when it's the engineering-admission page; the
      // filter keeps the result topically locked to the asked program.
      // Multiple slices of the same source page (program:astronomy:1..N)
      // are kept on purpose — they're different sub-sections of the same
      // canonical page (admission rules, degree requirements, contact),
      // so each adds information rather than duplicating it.
      const haystack = `${c.title}\n${c.text}`.toLowerCase()
      if (!aliasKeywords.some((kw) => haystack.includes(kw))) continue
      out.push({ ...c, score: scores[i] })
    }
    return enforceTokenBudget(easterCollapse(out))
  }

  // ---- Mode C: default semantic mode ----
  // Top-K by score with the minScore floor. For greetings and off-topic
  // queries every chunk's cosine sits near zero, so this returns [];
  // userPromptWithContext + the SCOPE rule then handle the empty case.
  //
  // Per-source dedup: top-K should be K distinct sources, not K slices
  // of the same page. We dedup on `c.code ?? c.url` because course
  // chunks all share a single per-subject URL (every CPSC course points
  // at /course-descriptions/subject/cpscv) — using URL alone collapsed
  // every CPSC course into a single chunk and let lower-scoring chunks
  // from other subjects (ATSC 212, MATH 442, …) take the freed slots.
  // For programs and easters c.code is null, so dedup falls back to URL,
  // preserving the original "one chunk per program page" behaviour.
  const modeC: Chunk[] = []
  const seenKeysC = new Set<string>()
  // Sorted descending by score, so break (not continue) once we drop
  // below minScore — every remaining chunk fails the gate. This is the
  // loop's natural termination condition; enforceTokenBudget below
  // trims further if the score-passing set is still too large.
  for (const i of allIndicesByScore) {
    if (scores[i] < minScore) break
    const c = chunks[i]
    const key = c.code ?? c.url
    if (seenKeysC.has(key)) continue
    seenKeysC.add(key)
    modeC.push({ ...c, score: scores[i] })
  }
  return enforceTokenBudget(easterCollapse(modeC))
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
