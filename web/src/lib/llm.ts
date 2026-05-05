// WebLLM wrapper that lazy-loads Qwen 2.5 1.5B Instruct and exposes a
// streaming chat API. We auto-discover the model id from prebuiltAppConfig
// so we don't break when WebLLM bumps versions.
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

// ---------- Diagnostic ring buffer ----------
//
// We're investigating "Buffer was unmapped before mapping was resolved"
// errors that fire from web-llm's deviceCopyFromGPU mapAsync. The proximate
// cause is GPUDevice loss, but we don't yet have ground truth on the
// trigger (tab idle, OS GPU reset, driver crash, etc.). This ring buffer
// captures recent events from both threads so the next time the error
// fires the user can hand us a copy of the timeline alongside the error.
//
// Sources:
//   - main: visibility transitions, engine lifecycle (creating/ready/
//     discarded), stream lifecycle (start/complete/error), worker errors.
//   - worker: adapter/device acquired (with adapter.info), and most
//     importantly device.lost firings — relayed via `kind: 'diag'`
//     postMessages from llm.worker.ts.
//
// Capped at DIAG_LOG_MAX entries; oldest dropped first. Snapshotted into
// ChatError.diag when streamChat throws so the user can copy the full
// pre-error timeline from the error UI.
export interface DiagEvent {
  timestamp: number
  source: 'main' | 'worker'
  event: string
  detail?: Record<string, unknown> | null
}

const DIAG_LOG_MAX = 100
const diagLog: DiagEvent[] = []

function logDiag(
  source: DiagEvent['source'],
  event: string,
  detail?: Record<string, unknown> | null,
): void {
  diagLog.push({ timestamp: Date.now(), source, event, detail: detail ?? null })
  if (diagLog.length > DIAG_LOG_MAX) diagLog.shift()
  // Also mirror to console — `console.debug` so devtools doesn't surface
  // it by default, but it's there if needed during live investigation.
  if (detail) console.debug('[llm.diag]', source, event, detail)
  else console.debug('[llm.diag]', source, event)
}

export function getDiagSnapshot(): DiagEvent[] {
  return [...diagLog]
}

// Visibility transitions — recorded so we can tell whether a device-lost
// firing immediately follows a hidden→visible flip (which would point at
// browser GPU release on idle tabs).
if (typeof document !== 'undefined') {
  logDiag('main', 'visibility-initial', { state: document.visibilityState })
  document.addEventListener('visibilitychange', () => {
    logDiag('main', 'visibility', { state: document.visibilityState })
  })
}

function pickModelId(): string {
  const ids = prebuiltAppConfig.model_list.map((m) => m.model_id)
  // Qwen 2.5 1.5B Instruct, with the Coder/Math siblings explicitly excluded
  // — they share the "1.5B-Instruct" stem but are tuned for code/math, not
  // general-purpose academic-advisor RAG. Fallbacks try Qwen2 1.5B Instruct
  // (older webllm versions before Qwen2.5 was added) and a generic 1.5B
  // Instruct match as a last resort.
  const isExcluded = (id: string) => /coder|math/i.test(id)
  const matchers = [
    /qwen-?2\.?5[-_]1\.?5b[-_]instruct/i,
    /qwen-?2[-_]1\.?5b[-_]instruct/i,
    /qwen.*1\.?5b.*instruct/i,
  ]
  let pool: string[] = []
  for (const re of matchers) {
    pool = ids.filter((id) => re.test(id) && !isExcluded(id))
    if (pool.length) break
  }
  if (!pool.length) {
    throw new Error(
      `Could not find a Qwen 2.5 1.5B Instruct model in WebLLM. ` +
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
// Marker substring on the synthetic stall error thrown by streamChat when
// the worker stops sending deltas. Matched by isStaleEngineError below so
// the existing recovery path (discardEngine + retry on first attempt)
// kicks in transparently — a stalled GPU process is functionally identical
// to a stale engine and wants the same fix (rebuild from cached weights).
const STREAM_STALL_MESSAGE =
  'LLM stream stalled — no output from worker, rebuilding engine'

function isStaleEngineError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /Model not loaded/i.test(msg) ||
    /Buffer was unmapped/i.test(msg) ||
    /Buffer is destroyed/i.test(msg) ||
    /device (?:is |was )?lost/i.test(msg) ||
    msg.includes(STREAM_STALL_MESSAGE)
  )
}

function discardEngine() {
  logDiag('main', 'engine-discarded', { hadWorker: activeWorker !== null })
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
  logDiag('main', 'worker-spawning')
  const worker = new Worker(new URL('./llm.worker.ts', import.meta.url), {
    type: 'module',
  })
  // The worker doesn't go through any chat-completion promise we'd catch in
  // streamChat. Wire onerror/onmessageerror so a crash in the worker (e.g.
  // worker-side init throwing, postMessage of an unstructured-cloneable
  // value) at least logs loudly and tears the engine down so the next call
  // rebuilds instead of silently re-attaching to a corpse.
  worker.onerror = (e) => {
    logDiag('main', 'worker-error', {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
    })
    console.error('[llm.worker] error', {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      raw: e,
    })
    if (activeWorker === worker) discardEngine()
  }
  worker.onmessageerror = (e) => {
    logDiag('main', 'worker-messageerror')
    console.error('[llm.worker] messageerror', e)
    if (activeWorker === worker) discardEngine()
  }
  // Diag listener: relays `kind: 'diag'` messages from the worker into the
  // shared diagLog. addEventListener (not onmessage) so it coexists with
  // WebLLM's own UUID-keyed RPC listener — neither sees the other's
  // messages because they use disjoint shapes.
  worker.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data as
      | { kind?: string; event?: string; timestamp?: number; detail?: Record<string, unknown> | null }
      | undefined
    if (data?.kind !== 'diag' || typeof data.event !== 'string') return
    diagLog.push({
      timestamp: data.timestamp ?? Date.now(),
      source: 'worker',
      event: data.event,
      detail: data.detail ?? null,
    })
    if (diagLog.length > DIAG_LOG_MAX) diagLog.shift()
    if (data.detail) console.debug('[llm.diag] worker', data.event, data.detail)
    else console.debug('[llm.diag] worker', data.event)
    // device-lost is the smoking-gun event for our investigation. Promote
    // it to a visible warning so the user notices in the live console too,
    // not just inside the diagLog snapshot attached to a future error.
    if (data.event === 'device-lost') {
      console.warn(
        '[llm] GPUDevice was lost in the worker:',
        data.detail,
        'discarding engine for next-send rebuild',
      )
      if (activeWorker === worker) discardEngine()
    }
  })
  return worker
}

export function getLLM(onProgress?: LoadProgress): Promise<MLCEngineInterface> {
  if (!enginePromise) {
    logDiag('main', 'engine-creating')
    const worker = spawnWorker()
    activeWorker = worker
    enginePromise = CreateWebWorkerMLCEngine(worker, pickModelId(), {
      initProgressCallback: (r) => onProgress?.(r),
    })
      .then((engine) => {
        logDiag('main', 'engine-ready')
        return engine
      })
      .catch((err) => {
        logDiag('main', 'engine-create-failed', {
          message: err instanceof Error ? err.message : String(err),
        })
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
// never-ending repeating answer). The system prompt asks for concise
// replies (the soft cap); HARD_WORD_CAP at 200 is the JS-side backstop
// that triggers interruptGenerate() so a runaway generation can't keep
// the GPU pinned forever. Measured in whitespace-separated tokens —
// close enough to "words" for a length backstop, and cheap to recompute
// on every delta without a real tokenizer.
const HARD_WORD_CAP = 200

// Inactivity timeout for the worker stream. If no delta arrives within this
// window — counted from either stream-start or the last received delta — we
// assume the worker is wedged (GPU process crash, silent device-lost, etc.)
// and throw a synthetic stall error. The catch below routes that through
// the same discardEngine + retry path as a stale-engine error, so the user
// gets a fresh rebuild on their next send instead of a permanently spinning
// "Generating…" placeholder. 60s is generous enough to cover cold-start
// prefill on a 1.5B model + the longest expected inter-token gap on a slow
// laptop, but short enough that a real freeze doesn't trap the UI for ages.
const STREAM_INACTIVITY_TIMEOUT_MS = 60_000

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
  logDiag('main', 'stream-start', { messageCount: messages.length })
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
          // temperature, a 1.5B model will sometimes prefer a fluent
          // parametric answer over the verbatim grounded one. 0 keeps
          // it on the chunk-supported path and makes refusals reliable.
          temperature: opts.temperature ?? 0,
        })
        let accumulated = ''
        // Manual iteration (not for-await) so each next() can be raced
        // against an inactivity timer. for-await offers no hook to bail
        // out when the worker silently stops responding.
        const iter = stream[Symbol.asyncIterator]()
        while (true) {
          let timeoutId: ReturnType<typeof setTimeout> | undefined
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error(STREAM_STALL_MESSAGE))
            }, STREAM_INACTIVITY_TIMEOUT_MS)
          })
          let result: IteratorResult<Awaited<ReturnType<typeof iter.next>>['value']>
          try {
            // If the timeout wins, iter.next() is left pending. We don't
            // await iter.return() here — a stalled worker won't respond
            // to it either, and discardEngine() in the catch path
            // terminates the worker outright, which is the only reliable
            // way to release the suspended request.
            result = (await Promise.race([
              iter.next(),
              timeoutPromise,
            ])) as IteratorResult<Awaited<ReturnType<typeof iter.next>>['value']>
          } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId)
          }
          if (result.done) break
          const chunk = result.value
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
                // missing, breaking the loop still ends our yield —
                // the iterator's return() call propagates to the
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
        logDiag('main', 'stream-complete', { recovered, attempt })
        return { recovered }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const stale = isStaleEngineError(err)
        logDiag('main', 'stream-error', {
          message: errMsg,
          name: err instanceof Error ? err.name : undefined,
          stale,
          yielded,
          attempt,
        })
        if (stale) {
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
