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

export interface Chunk {
  id: string
  kind: 'course' | 'program'
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

  // Drop chunks below the relevance floor before sorting. For greetings and
  // off-topic queries every chunk's cosine sits near zero, so this returns
  // []; userPromptWithContext + the SCOPE rule then handle the empty case.
  const indices = Array.from(scores.keys()).filter((i) => scores[i] >= minScore)
  indices.sort((a, b) => scores[b] - scores[a])
  return indices.slice(0, k).map((i) => ({ ...chunks[i], score: scores[i] }))
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
