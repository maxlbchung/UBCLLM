import type { Chunk } from './retrieve'

export const SYSTEM_PROMPT =
  `Answer questions about UBC Vancouver courses and programs using only the sources provided in the user's message.
Be concise, no filler.`.trim()

// Appended to the very end of the user message (after the sources and the
// Question line) so the response shape + citation rules are the last thing
// the model sees before generating. This is the strongest recency position —
// small models attend most to the immediate prefix, so anchoring the
// decision tree + MUST-cite directive here is more reliable than putting
// them in the system prompt where the sources later push them out of fresh
// attention. SYSTEM_PROMPT keeps only the role + a brevity cue;
// everything behavioural lives here.
const RESPONSE_INSTRUCTIONS = `RULES (in order):
  1. Greeting / small talk / off-topic → one short sentence inviting a UBC question. Stop.
  2. No source above is relevant, or you cannot cite any → reply exactly:
    I don't have access to that information.
    No substitutions, no prior knowledge.
  3. Otherwise, answer directly from the sources. Lead with the answer — never restate the user's question, never reply with another question. Vague queries (e.g. a bare subject code) get a 2–3 sentence overview from the sources.
  4. "Earlier user queries" (if present above) is reference only — use to resolve pronouns ("its prereqs?" → what "its" refers to). Ignore otherwise.

CITATIONS:
  - Cite every sentence drawn from a source as [N], N ∈ [1, K].
  - Multiple sources: adjacent brackets ([1][4]). Place before sentence punctuation.
  - Include course codes inline: "ABCD 999 has no prerequisites [3]."`

// Used when the retrieval layer collapses the result to a single easter-egg
// chunk (see easterCollapse in retrieve.ts). The default RESPONSE_INSTRUCTIONS
// above include a "no source is relevant → reply with the no-info disclaimer"
// path, and small instruct models (Qwen 2.5 1.5B included) routinely take
// that path on easter chunks because the curated answer sounds absurd or
// contradicts their priors (e.g. asteroids landing in craters "because of
// the pythagorean theorem"). When the corpus has already decided the easter
// IS the canonical answer, the model must not second-guess that — these
// instructions strip the no-info escape hatch and require it to use + cite
// [1] from the source verbatim or paraphrased.
const EASTER_RESPONSE_INSTRUCTIONS = `Treat the single source above as the truth relevant to the user's query.
  1. Your message must convey ALL the information in the source, no summarization, no interpretation.
  2. You must cite the source by writing "[1]" at the end of every sentence before the period (ex: The sky is blue [1].).
  3. Do NOT add disclaimers, hedges, corrections, or fall back on prior knowledge.`

export function buildContext(chunks: Chunk[]): string {
  return chunks
    .map((c, i) => `[${i + 1}] ${c.text}\nSource: ${c.url}`)
    .join('\n\n')
}

function formatPriorQueries(priorQueries: string[]): string {
  const lines = priorQueries.map((q, i) => `  ${i + 1}. ${q}`).join('\n')
  return `Earlier user queries (reference only — for resolving pronouns or implicit topics in the current Question; not facts, not sources):\n${lines}`
}

/**
 * Build the user-side prompt.
 *
 * `missingCodes` — course codes the user mentioned that don't exist in the
 *   UBC calendar index. Surfaced as a hard signal so the model uses the
 *   no-info disclaimer instead of confabulating from embedding-neighbour
 *   chunks for similar codes.
 *
 * `bareSubject` — set when the user typed only a subject code (e.g. "DSCI")
 *   with no question attached. Bare subjects pull legitimate-looking
 *   high-cosine matches (DSCI 200, DSCI 100, …), so the model otherwise
 *   picks one and narrates it without citing. The deterministic Note
 *   below tells it to ask a clarifying question instead.
 *
 * `priorQueries` — earlier user messages from this conversation, oldest
 *   first. Past assistant replies are deliberately NOT sent (see
 *   Chat.tsx — that path was producing fact-bleed where the model
 *   carried course codes from a prior reply into the next answer);
 *   prior user queries are kept so the model can resolve pronouns
 *   like "its prereqs?" against the topic the user named earlier.
 *   Rendered as a "Earlier user queries" block right before the
 *   Question line, with Rule 4 in RESPONSE_INSTRUCTIONS pinning
 *   their semantics to "reference only, not facts".
 */
export function userPromptWithContext(
  query: string,
  chunks: Chunk[],
  missingCodes: string[] = [],
  bareSubject?: string,
  priorQueries: string[] = [],
): string {
  const parts: string[] = []

  if (bareSubject) {
    parts.push(
      `Note: The user typed only the subject code "${bareSubject}" with no question attached. Ask one short clarifying question (e.g. which specific course, or which aspect — prerequisites, description, requirements, level). Do not cite anything; ignore any sources below.`,
    )
  }

  if (missingCodes.length > 0) {
    const list = missingCodes.join(', ')
    const isPlural = missingCodes.length > 1
    parts.push(
      `Note: ${list} ${isPlural ? 'are' : 'is'} not listed in the UBC Vancouver calendar. Use the no-info disclaimer for ${isPlural ? 'these courses' : 'this course'} and do not substitute another course.`,
    )
  }

  if (chunks.length === 0) {
    if (priorQueries.length > 0) {
      parts.push(formatPriorQueries(priorQueries))
    }
    parts.push(`Question: ${query}`, '(No matching sources found in the UBC calendar.)')
  } else {
    parts.push('Sources from the UBC academic calendar:', buildContext(chunks))
    if (priorQueries.length > 0) {
      parts.push(formatPriorQueries(priorQueries))
    }
    parts.push(`Question: ${query}`)
  }

  // Append the response-shape + citation rules at the very end so they
  // sit in the freshest attention position before generation. Skip on
  // the bareSubject path — its Note already tells the model to ignore
  // sources, ask a clarifying question, and not cite, which would
  // contradict the DECIDE FIRST + MUST-cite block here. When retrieval
  // has collapsed to a single easter chunk (easterCollapse in retrieve.ts),
  // swap in EASTER_RESPONSE_INSTRUCTIONS so the model uses + cites the
  // curated answer instead of falling through to the no-info disclaimer.
  if (!bareSubject) {
    const easterOnly = chunks.length === 1 && chunks[0].kind === 'easter'
    parts.push(easterOnly ? EASTER_RESPONSE_INSTRUCTIONS : RESPONSE_INSTRUCTIONS)
  }

  return parts.join('\n\n')
}
