// WebLLM wrapper that lazy-loads a Qwen3.5 variant (2B today; 4B / 9B
// matchers stay defined below for the eventual re-enable) and exposes a
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
import type { ModelSize } from '../store/settings'

let enginePromise: Promise<MLCEngineInterface> | null = null
let activeWorker: Worker | null = null
// The size that enginePromise was created for. Used so callers can
// detect a size-switch (user picks a different variant) and tear the
// engine down before requesting the new one — different weights need a
// different worker. `null` means no engine is alive.
let activeSize: ModelSize | null = null

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

// Subscribe to worker-side GPU diagnostics (device acquisition,
// device.lost firings, GPU uncaptured errors). The worker posts on this
// channel via BroadcastChannel — bypassing the WebLLM worker.onmessage
// handler that would otherwise reject any non-RPC message as
// UnknownMessageKindError. Events land in the same diagLog ring so the
// in-app error UI surfaces them alongside main-thread events with
// chronological context.
if (typeof BroadcastChannel !== 'undefined') {
  const gpuDiagChannel = new BroadcastChannel('ubcllm-gpu-diag')
  gpuDiagChannel.onmessage = (e: MessageEvent) => {
    const msg = e.data as {
      event?: string
      detail?: Record<string, unknown> | null
    } | null
    if (!msg || typeof msg.event !== 'string') return
    logDiag('worker', msg.event, msg.detail ?? null)
  }
}

// Matchers per size — strict Qwen3.5 only. Earlier matchers had a
// Qwen3 fallback ("if no Qwen3.5-Xb is found, accept Qwen3-Xb"), but
// in practice that path silently substituted a non-instruct-tuned 8B
// base model into the 9B slot and the user got hangs that looked like
// timeouts. Strict matching surfaces a real error in the load banner
// instead, so we notice when WebLLM stops shipping a tier.
//
// Only the 2B matcher is reached in practice today; the app auto-loads
// '2b' on startup with no user choice. The 4B and 9B matchers stay
// here because RAG-length prefill on 3-4B-class models on this
// hardware/Chrome/Dawn combo deterministically hangs the GPU
// (DXGI_ERROR_DEVICE_HUNG); they're kept so re-enabling either tier
// later is a one-line change in the loader.
//
// Size keys match the user-facing tier labels: '2b' / '4b' / '9b'.
// Coder / Math siblings are excluded because they share the size stem
// but aren't chat-tuned.
const MODEL_MATCHERS: Record<ModelSize, RegExp> = {
  '2b': /qwen-?3\.?5[-_]2b/i,
  '4b': /qwen-?3\.?5[-_]4b/i,
  '9b': /qwen-?3\.?5[-_]9b/i,
}

/**
 * Human-readable model name for a size tier. Used by the picker, the
 * loading banner, and the home-page status pill. The branching exists
 * so a tier mapping to a non-Qwen3.5 underlying model still labels
 * accurately. All tiers map to Qwen3.5 today.
 */
export function modelLabel(size: ModelSize): string {
  return `Qwen3.5 ${size.toUpperCase()}`
}

function pickModelId(size: ModelSize): string {
  const ids = prebuiltAppConfig.model_list.map((m) => m.model_id)
  const isExcluded = (id: string) => /coder|math/i.test(id)
  const pool = ids.filter(
    (id) => MODEL_MATCHERS[size].test(id) && !isExcluded(id),
  )
  if (!pool.length) {
    throw new Error(
      `Could not find a Qwen ${size.toUpperCase()} variant in WebLLM. ` +
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

// Marker rejection used by the per-stream abortPromise. Caught inside
// the iter loop and translated into a clean `aborted: true` return so
// the user's Stop click doesn't fall through to the generic error
// catch (which would set a ChatError + ErrorDetails on the message).
const ABORT_MARKER = '__UBCLLM_STREAM_ABORTED__'

// Cap on how long we'll keep iter.next()-ing an abandoned stream after
// abort/word-cap. WebLLM's worker generator releases its per-pipeline
// lock at its final yield (see asyncGenerate in @mlc-ai/web-llm); if we
// don't drain those final yields, the lock stays held and the *next*
// chat.completions.create() blocks on lock.acquire() forever — that's
// the "thinking dots never stop after Stop" bug. Mid-generation aborts
// drain in ~2 next() calls (worker checks interruptSignal between
// tokens, breaks the auto-regressive loop, yields the finish-reason
// chunk, releases lock). Mid-prefill aborts can't be interrupted until
// the prefill kernel completes, but on the 2B tier that's well under
// a couple of seconds. 10s is generous headroom; past that we assume
// the worker is wedged and tear it down so the next send rebuilds.
const DRAIN_TIMEOUT_MS = 10_000

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

// Reasons we tear down the engine. Distinguishing them lets the UI react
// appropriately: a 'size-switch' is expected (startLoad immediately
// spawns the new tier), but 'worker-error' / 'device-lost' /
// 'stale-engine' are involuntary and the caller (llmLoader) should flip
// loadedFor back to null so the UI doesn't lie about engine readiness.
export type DiscardReason =
  | 'size-switch'
  | 'worker-error'
  | 'worker-messageerror'
  | 'device-lost'
  | 'stale-engine'
  | 'load-failed'

type DiscardListener = (reason: DiscardReason) => void
let discardListener: DiscardListener | null = null

/**
 * Subscribe to engine-discard events. Called by useLLMLoader at module
 * init so its `loadedFor` state can be reset to null when the engine
 * goes away unexpectedly (device-lost, worker crash, stale-engine retry
 * giving up). Only one listener at a time — the loader is the only
 * legitimate consumer.
 */
export function setEngineDiscardListener(fn: DiscardListener | null): void {
  discardListener = fn
}

function discardEngine(reason: DiscardReason = 'stale-engine') {
  logDiag('main', 'engine-discarded', {
    hadWorker: activeWorker !== null,
    reason,
  })
  enginePromise = null
  activeSize = null
  // Tear down the worker so the next getLLM() spawns a fresh one with a
  // clean GPUDevice. Reusing the same worker after device-lost just leaves
  // it stuck — its handler's MLCEngine has been unloaded internally.
  if (activeWorker) {
    activeWorker.terminate()
    activeWorker = null
  }
  // Notify subscribers AFTER the local state is cleared, so a listener
  // that calls back into getActiveModelSize() sees the post-discard
  // value (null). Wrapped in try/catch so a buggy listener can't leave
  // the engine in a half-discarded state.
  if (discardListener) {
    try {
      discardListener(reason)
    } catch (err) {
      console.error('[llm] discard listener threw', err)
    }
  }
}

/**
 * Force-tear-down of the active engine. Used when the user picks a
 * different model size — the worker still holds the previous weights
 * pinned in GPU memory, so we kill it before the next getLLM() spawns
 * a fresh one. Externally identical to discardEngine() but named for
 * intent so the size-switch path reads correctly at the call site.
 */
export function unloadEngine() {
  if (enginePromise) discardEngine('size-switch')
}

/**
 * The model size the engine is currently loaded for, or null if no
 * engine is alive. Mostly vestigial now that the app auto-loads 2B,
 * but still useful as a "has the engine finished initializing" check.
 */
export function getActiveModelSize(): ModelSize | null {
  return activeSize
}

/**
 * Prewarm the engine by running a throwaway 1-token completion. The
 * first chat.completions.create call after a fresh engine load forces
 * WebGPU to JIT-compile the prefill + decode shader pipelines, which
 * is the dominant cost of the slow "first response" the user notices.
 * Subsequent calls reuse the cached pipelines and start streaming
 * within a few hundred ms.
 *
 * Called from useLLMLoader.startLoad after getLLM() resolves but
 * before `loadedFor` is flipped, so the user only sees the composer
 * enable once the shaders are compiled and the first real send is
 * already fast. Errors here are non-fatal and logged — if warmup
 * fails, a real chat call would fail too, but we'd rather let the
 * user discover that on their own send than refuse to enable the
 * composer.
 */
export async function warmupEngine(size: ModelSize): Promise<void> {
  const engine = await getLLM(size)
  logDiag('main', 'warmup-start', { size })
  await engine.resetChat()
  const stream = await engine.chat.completions.create({
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    temperature: 0,
    max_tokens: 1,
    extra_body: { enable_thinking: false },
  })
  let tokens = 0
  for await (const _chunk of stream) {
    tokens++
  }
  await engine.resetChat()
  logDiag('main', 'warmup-complete', { size, tokens })
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
    if (activeWorker === worker) discardEngine('worker-error')
  }
  worker.onmessageerror = (e) => {
    logDiag('main', 'worker-messageerror')
    console.error('[llm.worker] messageerror', e)
    if (activeWorker === worker) discardEngine('worker-messageerror')
  }
  // NOTE: do not addEventListener('message') here. WebLLM's
  // WebWorkerMLCEngine claims `worker.onmessage` and throws
  // UnknownMessageKindError on anything it doesn't recognize — and
  // because `worker.onmessage = ...` doesn't compose with an
  // addEventListener, a side-channel post from the worker would still
  // hit WebLLM's handler first and surface as an unhandled error every
  // turn. Device-lost detection now happens via the chat-completion
  // error path (isStaleEngineError + the stale-engine retry in
  // streamChat catches "device lost" / "Buffer was unmapped").
  return worker
}

/**
 * Get a ready MLCEngine for the given size, lazily creating one if
 * needed. If a different size is currently loaded the previous engine
 * is torn down first — only one size lives in memory at a time.
 *
 * When called with no argument, returns whatever engine is currently
 * alive (matches pre-1.8 semantics for streamChat's internal use,
 * where the size is fixed by the time the call lands). Throws if no
 * engine has been created yet — the caller is expected to have
 * triggered a load via `useLLMLoader.startLoad(size)` first.
 */
export function getLLM(
  size?: ModelSize,
  onProgress?: LoadProgress,
): Promise<MLCEngineInterface> {
  if (size && activeSize && activeSize !== size) {
    logDiag('main', 'engine-size-switch', { from: activeSize, to: size })
    discardEngine()
  }
  if (!enginePromise) {
    if (!size) {
      throw new Error(
        'No model is loaded. Pick a size from the chat picker first.',
      )
    }
    logDiag('main', 'engine-creating', { size })
    const worker = spawnWorker()
    activeWorker = worker
    activeSize = size
    enginePromise = CreateWebWorkerMLCEngine(worker, pickModelId(size), {
      initProgressCallback: (r) => onProgress?.(r),
    })
      .then((engine) => {
        logDiag('main', 'engine-ready', { size })
        return engine
      })
      .catch((err) => {
        logDiag('main', 'engine-create-failed', {
          message: err instanceof Error ? err.message : String(err),
        })
        enginePromise = null
        activeSize = null
        worker.terminate()
        if (activeWorker === worker) activeWorker = null
        // Notify the loader so a half-loaded UI doesn't get stuck
        // showing "ready" — load failures will rethrow up to startLoad
        // anyway, but the listener fires the same teardown path as
        // device-lost so any code subscribed to discards stays in sync.
        if (discardListener) {
          try {
            discardListener('load-failed')
          } catch (listenerErr) {
            console.error('[llm] discard listener threw', listenerErr)
          }
        }
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
// never-ending repeating answer). The system prompt asks for under 80
// words / 4 sentences (the soft cap, in SYSTEM_PROMPT_BASE in prompts.ts);
// HARD_WORD_CAP at 200 is the JS-side backstop that triggers
// interruptGenerate() so a runaway generation can't keep the GPU pinned
// forever. The 2.5× ratio between soft and hard gives the model headroom
// to overshoot the soft target on legitimate detailed answers without
// getting clipped, while still cutting off true runaway loops earlier
// than the old 300-word cap (which let visibly-too-long answers stream
// for ~10 s before tripping). Measured in whitespace-separated tokens —
// close enough to "words" for a length backstop, and cheap to recompute
// on every delta without a real tokenizer.
const HARD_WORD_CAP = 300

// With `extra_body.enable_thinking: false` (set in streamChat below),
// WebLLM prepends a synthetic `<think>\n\n</think>\n\n` to the reply
// so the model skips its reasoning step. That block streams back as
// the first delta on every turn; this stripper eats it before yielding
// any visible content. Defensive: if a tier ever genuinely emits a
// `<think>...</think>` block of its own (toggle quietly stops working,
// model variant ignores it), the same logic strips that too.
// Once we've yielded any post-</think> content, all further deltas
// pass through untouched.
const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

// Defensive cap on how long we'll buffer a `<think>...` block waiting
// for the closing tag. With enable_thinking: false the prepended block
// closes on the first delta, so this cap normally doesn't fire — but
// if the toggle quietly stops working (or a future tier ignores it)
// the stripper would otherwise buffer deltas forever: tokens keep
// arriving so the inactivity timer never fires, but nothing yields,
// and the user sees thinking dots silently with no error. Past the
// cap, abandon the strip and yield everything in the buffer — the
// user sees raw `<think>…` text in the reply, which is strictly better
// than infinite thinking dots. 5000 chars ≈ ~1000 words of thinking
// before we give up.
const THINK_PREFIX_BUFFER_MAX = 5000

// Inactivity timeout for the worker stream. If no delta arrives within this
// window — counted from either stream-start or the last received delta — we
// assume the worker is wedged (GPU process crash, silent device-lost, etc.)
// and throw a synthetic stall error. The catch below routes that through
// the same discardEngine + retry path as a stale-engine error, so the user
// gets a fresh rebuild on their next send instead of a permanently spinning
// "Generating…" placeholder.
//
// Per-tier values: 2B's inter-token gaps are sub-second once generation
// starts and its cold prefill is well under 60s, so 60s catches genuine
// freezes without false positives. 4B's cold prefill with our ~8-chunk
// RAG context can take 60–90s on integrated GPUs before the first token
// arrives — 120s gives headroom there. 9B is pre-populated for the
// eventual re-enable but unused while only 2B is wired to the loader.
// Read at iter.next() time using `sizeAtEntry` so the right value
// applies to whichever tier this stream is talking to.
const STREAM_INACTIVITY_TIMEOUT_MS: Record<ModelSize, number> = {
  '2b': 60_000,
  '4b': 120_000,
  '9b': 180_000,
}

/**
 * Drain a stream iterator that was abandoned by the consumer (user Stop,
 * wallclock timeout, HARD_WORD_CAP). WebLLM's worker-side asyncGenerator
 * acquires a per-pipeline lock at chat.completions.create() and only
 * releases it at the generator's final yield — so abandoning the iterator
 * mid-stream leaves the lock held, and the *next* chat.completions.create()
 * blocks on lock.acquire() indefinitely. The user-visible symptom is that
 * the thinking indicator on the next message never clears.
 *
 * interruptGenerate() was already fired at the abort site, so the worker's
 * auto-regressive loop exits after the current token. Walking the iterator
 * to done=true lets the generator yield its finish-reason chunk and run
 * its lock.release() at the end. Capped by DRAIN_TIMEOUT_MS — past that
 * we assume the worker is wedged (interrupt arrived during a non-
 * interruptible kernel that never returned) and discard the engine so the
 * next send rebuilds from cache.
 *
 * Runs in the background; the streamChat generator returns to its caller
 * immediately on abort, but the chainTail release waits on this so the
 * next streamChat doesn't try to acquire the still-held lock.
 */
async function drainAbandonedIterator(
  iter: AsyncIterator<unknown>,
): Promise<void> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS
  try {
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        logDiag('main', 'drain-timeout-discard')
        discardEngine('stale-engine')
        return
      }
      const r = await Promise.race([
        iter.next(),
        new Promise<'drain-timeout'>((resolve) =>
          setTimeout(() => resolve('drain-timeout'), remaining),
        ),
      ])
      if (r === 'drain-timeout') {
        logDiag('main', 'drain-timeout-discard')
        discardEngine('stale-engine')
        return
      }
      if ((r as IteratorResult<unknown>).done) {
        logDiag('main', 'drain-complete')
        return
      }
    }
  } catch (err) {
    // Iterator threw during drain — likely the worker died or was already
    // torn down by a stale-engine retry on another path. The lock is
    // released either way; just log and exit.
    logDiag('main', 'drain-error', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

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
 *
 * `opts.signal` is an AbortSignal the caller can fire to stop generation
 * — used by the Stop button in the composer and by the wallclock timeout
 * watchdog. When the signal aborts we call `engine.interruptGenerate()`
 * to release the GPU loop and return cleanly with `aborted: true`, so the
 * partial reply streamed up to that point survives and no error UI fires.
 *
 * `opts.size` is the model size the caller believes is loaded (usually
 * `useLLMLoader.loadedFor`). Used as the source of truth for which
 * weights to (re)load — avoids the "No model is loaded" race where a
 * device-lost firing between load completion and the user's first send
 * nulls module-level `activeSize` while the UI still shows "ready". With
 * a caller-provided size, the rebuild path in getLLM can transparently
 * respawn the worker for the right tier instead of throwing.
 */
export type StreamChatResult = {
  recovered: boolean
  // True when the caller's AbortSignal fired (Stop button or wallclock
  // watchdog). The caller distinguishes user vs. wallclock by tracking
  // which path called abort(); streamChat can't tell from the signal alone.
  aborted?: boolean
  // True when HARD_WORD_CAP tripped — a runaway-loop backstop that
  // interrupted the model after N words. Surfaced so the caller can
  // mark the assistant message with `stopReason: 'word_cap'` and the
  // user sees an explicit "Stopped at length limit" indicator instead
  // of a silently truncated reply.
  wordCapped?: boolean
}

export async function* streamChat(
  messages: ChatCompletionMessageParam[],
  opts: { temperature?: number; signal?: AbortSignal; size?: ModelSize } = {},
): AsyncGenerator<string, StreamChatResult, void> {
  const previous = chainTail
  let release!: () => void
  chainTail = new Promise<void>((r) => {
    release = r
  })

  let recovered = false
  // Drain-pending state: when the consumer abandons the WebLLM stream
  // iterator (user Stop, wallclock timeout, HARD_WORD_CAP), the worker
  // generator's per-pipeline lock stays held until its final yield. We
  // set this to a background drain that walks the iterator to done so
  // the lock can release; the outer finally then schedules chainTail
  // release on it instead of releasing immediately. Without this gating,
  // the next chat.completions.create() blocks on lock.acquire() forever
  // and the user sees thinking dots that never clear.
  let drainPromise: Promise<void> | null = null
  // Resolve the target size for this turn. Prefer the caller's explicit
  // hint (Chat.tsx passes useLLMLoader.loadedFor — the UI's source of
  // truth) and fall back to module-level activeSize. The fallback used to
  // be the only source, but if a device-lost / worker-error nulled
  // activeSize after the load completed, sizeAtEntry would be null here
  // and getLLM(undefined) throws "No model is loaded" — confusing because
  // the UI still shows "ready". With opts.size we always have a target
  // and the rebuild path in getLLM transparently respawns the worker.
  const sizeAtEntry: ModelSize | null = opts.size ?? activeSize
  logDiag('main', 'stream-start', { messageCount: messages.length, size: sizeAtEntry })
  try {
    await previous

    for (let attempt = 0; attempt < 2; attempt++) {
      const engine = await getLLM(sizeAtEntry ?? undefined)
      let yielded = false
      try {
        // Caller already cancelled before we even started: short-circuit.
        // Resetting the engine still runs so the next call gets a clean
        // KV cache. `aborted: true` lets the caller distinguish a pre-
        // start cancellation from a normal empty completion.
        if (opts.signal?.aborted) {
          logDiag('main', 'stream-aborted', { yielded: false, phase: 'pre-start' })
          return { recovered, aborted: true }
        }
        await engine.resetChat()
        const stream = await engine.chat.completions.create({
          messages,
          stream: true,
          // Greedy decoding for the RAG advisor task: at any meaningful
          // temperature, a 2B model will sometimes prefer a fluent
          // parametric answer over the verbatim grounded one. 0 keeps
          // it on the chunk-supported path and makes refusals reliable.
          temperature: opts.temperature ?? 0,
          // Disable Qwen3.5 reasoning mode at the chat-template layer.
          // WebLLM prepends a synthetic `<think>\n\n</think>\n\n` to
          // the reply, forcing the model to skip the thinking step
          // entirely. Applied uniformly to every tier (2B / 4B / 9B) —
          // on the larger tiers a real reasoning pass adds tens of
          // seconds per turn before the first answer token arrives,
          // and on 4B it sometimes ran long enough to be clipped by
          // HARD_WORD_CAP. The synthetic block still appears once at
          // the head of the stream — the prefix-strip below handles it.
          extra_body: { enable_thinking: false },
        })
        let accumulated = ''
        // Set true if the HARD_WORD_CAP backstop fires inside the
        // delta loop. Read once at stream-complete so the result flag
        // (wordCapped) reflects what actually happened — a clean EOS
        // exit leaves it false.
        let wordCapped = false
        // Leading-<think>-block strip state. Buffer deltas until we can
        // confirm whether the response opens with <think> or not, then
        // either eat through </think> or flush the buffer untouched.
        let prefixStripped = false
        let prefixBuf = ''
        // Abort handling: install ONE listener on the signal for the
        // whole stream (avoids per-token addEventListener churn) AND
        // one Promise we race each iter.next() against (lets us bail
        // out even if the worker is stuck in prefill and never
        // resolves iter.next()).
        //
        // interruptGenerate() alone isn't enough — on a heavy tier
        // like 4B/9B the worker can be deep in cold-start prefill
        // when the user clicks Stop, and the interrupt flag only
        // gets checked between generated tokens. Without the race,
        // we'd sit in `await iter.next()` waiting for a delta that
        // takes ages to arrive. The race breaks us out immediately;
        // the worker keeps working in the background but its output
        // is ignored, and resetChat() on the next send clears the
        // KV state.
        let abortReceived = false
        let signalAbort!: () => void
        const abortPromise = new Promise<never>((_, reject) => {
          signalAbort = () => reject(new Error(ABORT_MARKER))
        })
        // Swallow the rejection on a "no one listening" path — if the
        // user clicks Stop after the loop has already exited normally,
        // signalAbort() would otherwise produce an unhandled rejection.
        abortPromise.catch(() => {})
        const onAbort = () => {
          abortReceived = true
          try {
            engine.interruptGenerate()
          } catch {
            /* worker may already be tearing down — fine */
          }
          signalAbort()
        }
        if (opts.signal) {
          if (opts.signal.aborted) {
            onAbort()
          } else {
            opts.signal.addEventListener('abort', onAbort, { once: true })
          }
        }
        // Manual iteration (not for-await) so each next() can be raced
        // against an inactivity timer. for-await offers no hook to bail
        // out when the worker silently stops responding.
        const iter = stream[Symbol.asyncIterator]()
        // Set true on any early exit (abort, word-cap) so the inner
        // finally kicks off drainAbandonedIterator(iter). A clean EOS
        // exit leaves it false — the iterator already ran to done so
        // WebLLM's lock release at the generator's tail has already
        // fired and there's nothing left to drain.
        let needsDrain = false
        try {
          while (true) {
            // Caller cancelled — exit before doing more work. The
            // interruptGenerate() call already fired in onAbort, so the
            // worker is winding down; we don't need to wait for one
            // more token to come back.
            if (abortReceived) {
              logDiag('main', 'stream-aborted', { yielded, phase: 'mid-stream' })
              needsDrain = true
              return { recovered, aborted: true }
            }
            // Pick the per-tier inactivity budget. sizeAtEntry is the
            // size we captured at streamChat entry; the discardEngine
            // path can null activeSize mid-stream during stale-engine
            // retry, but sizeAtEntry stays put. Falls back to the 2B
            // value when we genuinely don't know (legacy callers that
            // didn't pass opts.size and activeSize was already null) —
            // a tighter-than-necessary timeout just surfaces the freeze
            // sooner, which is the safe direction.
            const inactivityMs = sizeAtEntry
              ? STREAM_INACTIVITY_TIMEOUT_MS[sizeAtEntry]
              : STREAM_INACTIVITY_TIMEOUT_MS['2b']
            let timeoutId: ReturnType<typeof setTimeout> | undefined
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                reject(new Error(STREAM_STALL_MESSAGE))
              }, inactivityMs)
            })
            let result: IteratorResult<Awaited<ReturnType<typeof iter.next>>['value']>
            try {
              // If the timeout or abort wins, iter.next() is left
              // pending. We don't await iter.return() — a stalled
              // worker won't respond to that either. For the abort
              // case the worker keeps running in the background;
              // resetChat() on the next send clears its KV state, and
              // a stale-engine error there would discard the engine
              // outright. For the timeout case, the surrounding catch
              // path discards the engine.
              result = (await Promise.race([
                iter.next(),
                timeoutPromise,
                abortPromise,
              ])) as IteratorResult<Awaited<ReturnType<typeof iter.next>>['value']>
            } catch (raceErr) {
              if (
                raceErr instanceof Error &&
                raceErr.message === ABORT_MARKER
              ) {
                logDiag('main', 'stream-aborted', {
                  yielded,
                  phase: 'race-abort',
                })
                needsDrain = true
                return { recovered, aborted: true }
              }
              throw raceErr
            } finally {
              if (timeoutId !== undefined) clearTimeout(timeoutId)
            }
            if (result.done) {
              // Stream ended on its own. If the listener fired while
              // we were awaiting this last next() — e.g. user clicked
              // Stop and the worker came back with EOS immediately —
              // surface that as `aborted` rather than a clean stop.
              // No drain needed here — result.done means the generator
              // already ran past its final yield, so the WebLLM lock
              // has been released.
              if (abortReceived) {
                logDiag('main', 'stream-aborted', { yielded, phase: 'last-token' })
                return { recovered, aborted: true }
              }
              break
            }
          const chunk = result.value
          const delta = chunk.choices[0]?.delta?.content
          if (delta) {
            let toYield: string
            if (prefixStripped) {
              toYield = delta
            } else {
              prefixBuf += delta
              if (prefixBuf.startsWith(THINK_OPEN)) {
                const closeIdx = prefixBuf.indexOf(THINK_CLOSE)
                if (closeIdx === -1) {
                  // Still waiting for </think>. Buffer must stay
                  // bounded — see THINK_PREFIX_BUFFER_MAX above. Past
                  // the cap, abandon the strip and yield the raw buffer
                  // (including the unclosed `<think>` tag). The user
                  // sees malformed output but the reply isn't silently
                  // black-holed.
                  if (prefixBuf.length > THINK_PREFIX_BUFFER_MAX) {
                    logDiag('main', 'think-buffer-cap', {
                      bufferLength: prefixBuf.length,
                    })
                    toYield = prefixBuf
                    prefixStripped = true
                  } else {
                    continue // wait for </think>
                  }
                } else {
                  toYield = prefixBuf
                    .slice(closeIdx + THINK_CLOSE.length)
                    .replace(/^\s+/, '')
                  prefixStripped = true
                }
              } else if (THINK_OPEN.startsWith(prefixBuf)) {
                continue // buffer might still grow into <think>
              } else {
                toYield = prefixBuf
                prefixStripped = true
              }
            }
            if (!toYield) continue
            yielded = true
            yield toYield
            accumulated += toYield
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
              wordCapped = true
              needsDrain = true
              break
            }
          }
          }
          logDiag('main', 'stream-complete', { recovered, attempt, wordCapped })
          return { recovered, wordCapped: wordCapped || undefined }
        } finally {
          // One-shot listener registered above the loop; remove it whether
          // we exited via break, return, or a thrown error. Cheap and
          // explicit so the AbortController the caller is holding doesn't
          // accumulate stale listeners across many turns.
          if (opts.signal) {
            opts.signal.removeEventListener('abort', onAbort)
          }
          // Aborted or word-capped exit: the consumer abandoned the
          // iterator before its final yield. Kick off a background
          // drain so WebLLM's per-pipeline lock can release; the outer
          // finally below schedules chainTail release on it so the
          // next streamChat doesn't deadlock on lock.acquire().
          if (needsDrain) {
            drainPromise = drainAbandonedIterator(iter)
          }
        }
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
    // chainTail release: if a background drain was kicked off (abort or
    // word-cap exit), gate release on its completion so the *next*
    // streamChat call doesn't try to call chat.completions.create()
    // while WebLLM's worker-side lock is still held. The drain itself
    // is non-blocking from the consumer's perspective — this generator
    // already returned its value; we're just delaying when subsequent
    // serialized calls (chainTail dependents) can proceed.
    if (drainPromise) {
      drainPromise.finally(release)
    } else {
      release()
    }
  }
}
