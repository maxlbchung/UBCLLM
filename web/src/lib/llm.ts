// WebLLM wrapper that lazy-loads Gemma 4 E2B and exposes a streaming chat API.
// We auto-discover the model id from prebuiltAppConfig so we don't break when
// WebLLM bumps versions.
//
// The actual MLCEngine runs in a Web Worker (./llm.worker.ts). Running off the
// main thread keeps the GPUDevice + model pipeline alive across page-lifecycle
// events (background tab throttling, brief visibility changes) that otherwise
// trigger device-lost → engine.unload() and the "Buffer was unmapped" /
// "Model not loaded" cascade. Workers also share IndexedDB with the main
// thread so the model cache transfers without a re-download.
import {
  CreateWebWorkerMLCEngine,
  prebuiltAppConfig,
  type ChatCompletionMessageParam,
  type InitProgressReport,
  type MLCEngineInterface,
} from '@mlc-ai/web-llm'

let enginePromise: Promise<MLCEngineInterface> | null = null
let activeWorker: Worker | null = null

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

// After the tab idles for a while, the WebGPU device can quietly drop the
// model's pipeline. The first send after wakeup then surfaces as
// "Buffer was unmapped before mapping was resolved" (a GPU buffer the streamer
// was reading from got torn down), and every subsequent send fails with
// "Model not loaded before trying to complete ChatCompletionRequest" (the
// engine's loaded flag flipped). Both recover by recreating the engine —
// weights are still cached in IndexedDB so re-init is ~1–3 s, not the full
// initial download.
function isStaleEngineError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /Model not loaded/i.test(msg) ||
    /Buffer was unmapped/i.test(msg) ||
    /Buffer is destroyed/i.test(msg) ||
    /device (?:is |was )?lost/i.test(msg)
  )
}

function discardEngine() {
  enginePromise = null
  // Tear down the worker so the next getLLM() spawns a fresh one with a
  // clean GPUDevice. Reusing the same worker after device-lost just leaves
  // it stuck — its handler's MLCEngine has been unloaded internally.
  if (activeWorker) {
    activeWorker.terminate()
    activeWorker = null
  }
}

function spawnWorker(): Worker {
  const worker = new Worker(new URL('./llm.worker.ts', import.meta.url), {
    type: 'module',
  })
  // The worker doesn't go through any chat-completion promise we'd catch in
  // streamChat. Wire onerror/onmessageerror so a crash in the worker (e.g.
  // worker-side init throwing, postMessage of an unstructured-cloneable
  // value) at least logs loudly and tears the engine down so the next call
  // rebuilds instead of silently re-attaching to a corpse.
  worker.onerror = (e) => {
    console.error('[llm.worker] error', {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      raw: e,
    })
    if (activeWorker === worker) discardEngine()
  }
  worker.onmessageerror = (e) => {
    console.error('[llm.worker] messageerror', e)
    if (activeWorker === worker) discardEngine()
  }
  return worker
}

export function getLLM(onProgress?: LoadProgress): Promise<MLCEngineInterface> {
  if (!enginePromise) {
    const worker = spawnWorker()
    activeWorker = worker
    enginePromise = CreateWebWorkerMLCEngine(worker, pickModelId(), {
      initProgressCallback: (r) => onProgress?.(r),
    }).catch((err) => {
      enginePromise = null
      worker.terminate()
      if (activeWorker === worker) activeWorker = null
      throw err
    })
  }
  return enginePromise
}

// Serialize calls to the engine: WebLLM's chat completion stream holds GPU
// buffer mappings that are torn down when the stream resolves, but a second
// call can race with that teardown and crash with
// "Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was unmapped before
// mapping was resolved". Awaiting the previous call before starting the next
// avoids the race; resetChat() clears any KV cache state left from the
// previous turn (we re-send the full message history each call anyway).
let chainTail: Promise<void> = Promise.resolve()

// Hard cutoff for the streamed response, used as a backstop against the
// model entering a degenerate repeat loop on adversarial / off-topic
// queries (e.g. "why do asteroids always land in craters?" hit a
// never-ending repeating answer). SYSTEM_PROMPT asks for under 150
// words (the soft cap); HARD_WORD_CAP at 200 is the JS-side backstop
// that triggers interruptGenerate() so a runaway generation can't
// keep the GPU pinned forever. Measured in whitespace-separated
// tokens — close enough to "words" for a length backstop, and cheap
// to recompute on every delta without a real tokenizer. Keep this in
// sync with the number in SYSTEM_PROMPT (prompts.ts).
const HARD_WORD_CAP = 200

/**
 * Stream chat completion deltas. The generator's *return value* (read via
 * the iterator protocol, not the for-await loop) signals whether the
 * discard-engine recovery path was hit on this turn — the caller can use
 * it to tell the user "the engine was rebuilt; your next message should
 * work" without inferring it from the error string.
 *
 * On a mid-stream stale-engine failure we still throw, but the thrown
 * error gets a `recovered = true` property attached (cast required since
 * Error doesn't widen) so the catch can read it.
 */
export type StreamChatResult = { recovered: boolean }

export async function* streamChat(
  messages: ChatCompletionMessageParam[],
  opts: { temperature?: number } = {},
): AsyncGenerator<string, StreamChatResult, void> {
  const previous = chainTail
  let release!: () => void
  chainTail = new Promise<void>((r) => {
    release = r
  })

  let recovered = false
  try {
    await previous

    for (let attempt = 0; attempt < 2; attempt++) {
      const engine = await getLLM()
      let yielded = false
      try {
        await engine.resetChat()
        const stream = await engine.chat.completions.create({
          messages,
          stream: true,
          // Greedy decoding for the RAG advisor task: at any meaningful
          // temperature, a 2B model will sometimes prefer a fluent
          // parametric answer over the verbatim grounded one. 0 keeps
          // it on the chunk-supported path and makes refusals reliable.
          temperature: opts.temperature ?? 0,
        })
        let accumulated = ''
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content
          if (delta) {
            yielded = true
            yield delta
            accumulated += delta
            // Whitespace-token count is approximate during streaming
            // (a partial word like "wor" reads as one token until the
            // closing delta arrives) but converges to the real count
            // by stream end. Slight over-count here makes us cut a
            // few tokens early — fine for a length backstop.
            const wordCount = accumulated.match(/\S+/g)?.length ?? 0
            if (wordCount >= HARD_WORD_CAP) {
              try {
                // Best-effort: tells the engine to stop generating so
                // the GPU loop terminates cleanly. If it throws or is
                // missing, breaking the for-await still ends our yield
                // — the iterator's return() call propagates to the
                // worker, and resetChat() at the next call's start
                // clears any leftover state anyway.
                engine.interruptGenerate()
              } catch {
                /* fall through to the break below */
              }
              break
            }
          }
        }
        return { recovered }
      } catch (err) {
        if (isStaleEngineError(err)) {
          // Force the next getLLM() to rebuild the engine from cached
          // weights. If we haven't yielded anything yet, retry transparently;
          // otherwise rethrow so the user sees what happened on this turn,
          // and their next send picks up the fresh engine.
          discardEngine()
          recovered = true
          if (!yielded && attempt === 0) continue
        }
        // Worker proxy rejections often arrive as bare strings (web-llm
        // does reject(msg.content) without re-Error-ifying). Strings can't
        // carry properties — assigning `recovered` to one throws TypeError
        // that masks the real GPU error in the user's debug surface.
        // Promote to a real Error first so the original message survives.
        const wrapped = err instanceof Error ? err : new Error(String(err))
        ;(wrapped as { recovered?: boolean }).recovered = recovered
        throw wrapped
      }
    }
    // Unreachable: the loop either returns or throws on every iteration.
    return { recovered }
  } finally {
    release()
  }
}
