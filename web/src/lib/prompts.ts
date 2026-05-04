import type { Chunk } from './retrieve'

export const SYSTEM_PROMPT =
  `Answer questions about UBC Vancouver courses and programs using only the sources provided in the user's message.
LENGTH: keep your entire response under 150 words.`.trim()

// Appended to the very end of the user message (after the sources and the
// Question line) so the response shape + citation rules are the last thing
// the model sees before generating. This is the strongest recency position —
// small models attend most to the immediate prefix, so anchoring the
// decision tree + MUST-cite directive here is more reliable than putting
// them in the system prompt where the sources later push them out of fresh
// attention. SYSTEM_PROMPT keeps only the role + length cap; everything
// behavioural lives here.
const RESPONSE_INSTRUCTIONS = `DECIDE FIRST which output shape fits the user's message:
  - Greeting / small talk / off-topic → one short sentence inviting a UBC question.
  - On-topic but vague (just a subject code like "ABCD", just a course code with no specific question) → ask one short clarifying question.
  - Specific UBC question relevant to the sources provided → answer using the sources, citing each factual sentence per the rules below. If no source supports the answer, your entire reply must be exactly:
      I don't have access to that information.
    Do not substitute a different course or fall back on prior knowledge.

HOW TO CITE FROM THE SOURCES ABOVE:
  - Every sentence referencing information from the sources must include a citation or citations.
  - N is an integer in [1, K] where K is the number of sources above.
  - For multiple sources, adjacent brackets: [1][4].
  - Place each citation immediately after its claim, before sentence punctuation.
  - When citing a course, include its code inline: "ABCD 999 has no prerequisites [3]."`

export function buildContext(chunks: Chunk[]): string {
  return chunks
    .map((c, i) => `[${i + 1}] ${c.text}\nSource: ${c.url}`)
    .join('\n\n')
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
 */
export function userPromptWithContext(
  query: string,
  chunks: Chunk[],
  missingCodes: string[] = [],
  bareSubject?: string,
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
    parts.push(`Question: ${query}`, '(No matching sources found in the UBC calendar.)')
  } else {
    parts.push(
      'Sources from the UBC academic calendar:',
      buildContext(chunks),
      `Question: ${query}`,
    )
  }

  // Append the response-shape + citation rules at the very end so they
  // sit in the freshest attention position before generation. Skip on
  // the bareSubject path — its Note already tells the model to ignore
  // sources, ask a clarifying question, and not cite, which would
  // contradict the DECIDE FIRST + MUST-cite block here.
  if (!bareSubject) {
    parts.push(RESPONSE_INSTRUCTIONS)
  }

  return parts.join('\n\n')
}
