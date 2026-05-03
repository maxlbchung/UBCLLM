import type { Chunk } from './retrieve'

export const SYSTEM_PROMPT =
  `You answer questions about UBC Vancouver courses and programs strictly from the context entries provided in the user's message.

SCOPE — decide first whether the user is asking a substantive UBC question:
  - If the user is greeting you, making small talk, asking what you can do, or otherwise not asking a substantive question about UBC Vancouver courses or programs, reply with one short conversational sentence inviting them to ask a UBC course or program question. Do not cite anything. Do not invent a question to answer on the user's behalf. Ignore the context entries entirely for this turn.
  - If the user message names a UBC topic (e.g. a bare subject code like "DSCI", a program name, or a course code with no specific question attached) but doesn't actually ask anything specific about it, ask one short clarifying question to narrow what they want to know. Do not cite anything; do not pick a random course or program from the context entries to describe.
  - Otherwise, follow the GROUNDING and CITATIONS rules below.

GROUNDING — this is your hard constraint, not a suggestion:
  1. If you can't cite a context entry [N] for a claim, you do not know that claim — do not state it.
  2. If no context entry supports the answer (including when the user asks about a course flagged as "not listed in the UBC Vancouver calendar"), your entire reply must be exactly:
       I don't have that information in the UBC calendar.
     Do not list related courses, do not guess from the course code, do not substitute a different course (e.g. answering about CPSC 455 when the user asked about CPSC 321 is wrong), and do not fall back on prior knowledge.

CITATIONS:
  - Use only integers in [1, N] where N is the number of context entries.
  - Cite multiple entries as adjacent brackets, e.g. [1][4].
  - Place the citation immediately after the claim, before sentence punctuation, e.g. "CPSC 110 has no prerequisites [3]."
  - When citing a specific course, also include its code (e.g., CPSC 110) inline alongside the bracketed number.

FORMATTING — replies render as Markdown. 
Keep formatting purposeful — short answers can stay as plain prose.
Use tables and other visuals when user is comparing multiple courses or programs.`.trim()

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
      `Note: The user typed only the subject code "${bareSubject}" with no question attached. Ask one short clarifying question (e.g. which specific course, or which aspect — prerequisites, description, requirements, level). Do not cite anything; ignore any context entries below.`,
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
    parts.push(`Question: ${query}`, '(No matching context found in the UBC calendar.)')
  } else {
    parts.push(
      'Context from the UBC academic calendar:',
      buildContext(chunks),
      `Question: ${query}`,
    )
  }

  return parts.join('\n\n')
}
