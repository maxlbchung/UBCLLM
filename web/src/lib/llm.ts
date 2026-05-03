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

function spawnWorker(): Worker {
  return new Worker(new URL('./llm.worker.ts', import.meta.url), {
    type: 'module',
  })
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

// Serialize calls to the engine: WebLLM's chat completion stream holds GPU
// buffer mappings that are torn down when the stream resolves, but a second
// call can race with that teardown and crash with
// "Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was unmapped before
// mapping was resolved". Awaiting the previous call before starting the next
// avoids the race; resetChat() clears any KV cache state left from the
// previous turn (we re-send the full message history each call anyway).
let chainTail: Promise<void> = Promise.resolve()

export async function* streamChat(
  messages: ChatCompletionMessageParam[],
  opts: { temperature?: number } = {},
): AsyncGenerator<string, void, void> {
  const previous = chainTail
  let release!: () => void
  chainTail = new Promise<void>((r) => {
    release = r
  })

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
          temperature: opts.temperature ?? 0.4,
        })
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content
          if (delta) {
            yielded = true
            yield delta
          }
        }
        return
      } catch (err) {
        if (isStaleEngineError(err)) {
          // Force the next getLLM() to rebuild the engine from cached
          // weights. If we haven't yielded anything yet, retry transparently;
          // otherwise rethrow so the user sees what happened on this turn,
          // and their next send picks up the fresh engine.
          discardEngine()
          if (!yielded && attempt === 0) continue
        }
        throw err
      }
    }
  } finally {
    release()
  }
}
