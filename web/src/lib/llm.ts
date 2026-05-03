// WebLLM wrapper that lazy-loads Gemma 4 E2B and exposes a streaming chat API.
// We auto-discover the model id from prebuiltAppConfig so we don't break when
// WebLLM bumps versions.
import {
  CreateMLCEngine,
  prebuiltAppConfig,
  type ChatCompletionMessageParam,
  type InitProgressReport,
  type MLCEngineInterface,
} from '@mlc-ai/web-llm'

let enginePromise: Promise<MLCEngineInterface> | null = null

function pickModelId(): string {
  const ids = prebuiltAppConfig.model_list.map((m) => m.model_id)
  // Try a few naming conventions WebLLM has used for the Gemma 4 E2B family.
  const matchers = [/gemma-?4-?e2b/i, /gemma-?3n-?e2b/i, /gemma.*2b.*it/i]
  let pool: string[] = []
  for (const re of matchers) {
    pool = ids.filter((id) => re.test(id))
    if (pool.length) break
  }
  if (!pool.length) {
    throw new Error(
      `Could not find a Gemma 2B-class model in WebLLM. ` +
        `Available: ${ids.slice(0, 5).join(', ')}…`,
    )
  }
  // Prefer 4-bit / 16-bit float quantization for size + speed.
  pool.sort((a, b) => quantScore(b) - quantScore(a))
  return pool[0]
}

function quantScore(id: string): number {
  if (id.includes('q4f16')) return 4
  if (id.includes('q4f32')) return 3
  if (id.includes('q0f16')) return 2
  if (id.includes('q0f32')) return 1
  return 0
}

export type LoadProgress = (r: InitProgressReport) => void

export function getLLM(onProgress?: LoadProgress): Promise<MLCEngineInterface> {
  if (!enginePromise) {
    enginePromise = CreateMLCEngine(pickModelId(), {
      initProgressCallback: (r) => onProgress?.(r),
    }).catch((err) => {
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

export async function* streamChat(
  messages: ChatCompletionMessageParam[],
  opts: { temperature?: number } = {},
): AsyncGenerator<string, void, void> {
  const engine = await getLLM()
  const stream = await engine.chat.completions.create({
    messages,
    stream: true,
    temperature: opts.temperature ?? 0.4,
  })
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) yield delta
  }
}
