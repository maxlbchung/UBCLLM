// Building resolution for the campus map: exact code, then acronym alias
// ("IKB" → IBLC), then fuzzy name search — the same ladder Reogent's
// resolveBuilding walks against Meilisearch, reimplemented over the static
// buildings-index.json (449 docs — linear scans are instant).
import { getBuildingIndex } from './data'
import type { BuildingDoc } from './types'

/** Relevance of `doc` for a free-text query. 0 = no match. */
function fuzzyScore(doc: BuildingDoc, queryUpper: string, tokens: string[]): number {
  const name = doc.name.toUpperCase()
  const code = doc.code.toUpperCase()
  let score = 0
  if (name === queryUpper || code === queryUpper) score += 100
  if (name.startsWith(queryUpper)) score += 40
  else if (name.includes(queryUpper)) score += 25
  if (code.startsWith(queryUpper)) score += 20
  if (doc.aliases.includes(queryUpper)) score += 30
  // Per-token word-prefix hits ("irving barber" → Irving K. Barber …)
  const words = name.split(/[^A-Z0-9]+/)
  let matched = 0
  for (const token of tokens) {
    if (words.some((w) => w.startsWith(token))) matched++
  }
  if (tokens.length > 0 && matched === tokens.length) score += 15
  score += matched * 5
  return score
}

/** Ranked building matches for a free-text query (for pickers/autocomplete). */
export async function searchBuildings(
  query: string,
  limit = 8,
): Promise<BuildingDoc[]> {
  const q = query.trim().toUpperCase()
  if (!q) return []
  const docs = await getBuildingIndex()
  const tokens = q.split(/[^A-Z0-9]+/).filter(Boolean)
  return docs
    .map((doc) => ({ doc, score: fuzzyScore(doc, q, tokens) }))
    .filter((r) => r.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.doc.name.length - b.doc.name.length,
    )
    .slice(0, limit)
    .map((r) => r.doc)
}

/** Exact code, then acronym alias, then fuzzy name search. Throws when the
 *  query matches nothing — callers surface that as "Unknown building". */
export async function resolveBuilding(query: string): Promise<BuildingDoc> {
  const norm = query.trim().toUpperCase()
  if (!norm) throw new Error('Building name or code is required')
  const docs = await getBuildingIndex()
  const byCode = docs.find((d) => d.code.toUpperCase() === norm)
  if (byCode) return byCode
  const byAlias = docs.find((d) => d.aliases.includes(norm))
  if (byAlias) return byAlias
  const [best] = await searchBuildings(query, 1)
  if (!best) throw new Error(`Unknown building: "${query}"`)
  return best
}
