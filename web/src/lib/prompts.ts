import type { Chunk } from './retrieve'

export const SYSTEM_PROMPT = `You are a UBC Vancouver academic advisor assistant.
Answer questions about courses, prerequisites, and degree programs using only
the context provided. If the context does not contain the answer, say:
"I don't have that information in the UBC calendar." Do not invent course
numbers, credits, prerequisites, or program requirements. When citing a
specific course or program, include its code (e.g., CPSC 110) and link if it
appears in the context.`.trim()

export function buildContext(chunks: Chunk[]): string {
  return chunks
    .map((c, i) => `[${i + 1}] ${c.text}\nSource: ${c.url}`)
    .join('\n\n')
}

export function userPromptWithContext(query: string, chunks: Chunk[]): string {
  if (chunks.length === 0) {
    return `Question: ${query}\n\n(No matching context found in the UBC calendar.)`
  }
  return `Context from the UBC academic calendar:\n${buildContext(chunks)}\n\nQuestion: ${query}`
}
