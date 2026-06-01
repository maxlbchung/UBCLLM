// Background model-load progress + status. The picker is gone — the app loads
// Qwen3.5 2B (the only supported tier) when the app shell opens. This store
// still exposes a `startLoad(size)` API because the internal
// machinery (lib/llm.ts MLCEngine worker, lib/retrieve.ts per-tier
// budgets) is tier-aware; callers just always pass '2b'.
//
// Non-persisted on purpose — the load itself is repeated on every
// reload, but it's nearly instant on the warm path (weights in
// IndexedDB), and persisting `progress` snapshots is pointless.
import { create } from 'zustand'
import {
  getLLM,
  unloadEngine,
  warmupEngine,
  getActiveModelSize,
  setEngineDiscardListener,
  type DiscardReason,
} from '../lib/llm'
import { playSfx } from '../lib/sfx'
import type { ModelSize } from './settings'
import type { ChatError } from './chat'

// The only tier the picker-less app loads. Kept as a named
// constant so the retry / cache-and-retry paths and the App-level
// app-shell route effect all refer to the same value.
export const DEFAULT_MODEL_SIZE: ModelSize = '2b'

// Same WebLLM progress-string heuristic the legacy ModelLoader used.
// Cold = "Fetching param cache[i/n]: …", warm = "Loading model from
// cache[i/n]: …". Sticky once classified so the final
// "Finish loading on WebGPU" tick doesn't erase the distinction.
// 'warming' is the post-weights-load phase where we run a throwaway
// 1-token completion to force WebGPU shader compilation; the LoadBanner
// renders this with its own caption so the user knows the bar at 100%
// isn't stuck.
type LoadMode = 'unknown' | 'cold' | 'warm' | 'warming'

function classifyProgressText(text: string): LoadMode | null {
  if (/fetching param cache/i.test(text)) return 'cold'
  if (/loading model from cache/i.test(text)) return 'warm'
  return null
}

async function clearWebLLMStorage() {
  try {
    const keys = await caches.keys()
    await Promise.all(
      keys.filter((k) => k.startsWith('webllm/')).map((k) => caches.delete(k)),
    )
  } catch {
    /* best-effort */
  }
  try {
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases()
      await Promise.all(
        dbs
          .filter((db) => db.name?.startsWith('webllm/'))
          .map((db) => indexedDB.deleteDatabase(db.name!)),
      )
    }
  } catch {
    /* best-effort */
  }
}

function toChatError(err: unknown): ChatError {
  const isErrInstance = err instanceof Error
  return {
    message: isErrInstance ? err.message : String(err),
    name: isErrInstance ? err.name : undefined,
    stack: isErrInstance ? err.stack : undefined,
  }
}

interface State {
  // The size currently being loaded, or null if idle. Distinct from
  // `loadedFor` so the UI can tell "loading 4B" apart from "2B is
  // loaded and now we're switching to 4B" — the chat picker greys out
  // accordingly.
  loadingFor: ModelSize | null
  loadedFor: ModelSize | null
  progress: number
  text: string
  mode: LoadMode
  error: ChatError | null
  // Bumped each time we start a fresh load attempt. Used as a guard so
  // an in-flight load that's been cancelled (newer attempt started)
  // doesn't write its progress callbacks over the new one.
  loadEpoch: number

  startLoad: (size: ModelSize) => Promise<void>
  clearError: () => void
  retry: () => Promise<void>
  clearCacheAndRetry: () => Promise<void>
}

export const useLLMLoader = create<State>((set, get) => ({
  loadingFor: null,
  loadedFor: getActiveModelSize(),
  progress: 0,
  text: '',
  mode: 'unknown',
  error: null,
  loadEpoch: 0,

  startLoad: async (size) => {
    const { loadingFor, loadedFor } = get()
    // Idempotency: if we're already loading or loaded for this size,
    // skip. Returns a resolved promise so callers can `await` without
    // branching on the current state.
    if (loadingFor === size) return
    if (loadedFor === size && !get().error) return

    // Size switch: drop the previous engine before starting the new
    // one. unloadEngine() is a no-op if nothing is alive.
    if (loadedFor && loadedFor !== size) unloadEngine()

    const epoch = get().loadEpoch + 1
    set({
      loadingFor: size,
      loadedFor: null,
      progress: 0,
      text: 'Initializing…',
      mode: 'unknown',
      error: null,
      loadEpoch: epoch,
    })

    try {
      await getLLM(size, (report) => {
        // Drop progress callbacks from a superseded load — otherwise a
        // user picking 2B → 4B in quick succession would see the 2B
        // worker's late progress ticks overwrite the 4B load's UI.
        if (get().loadEpoch !== epoch) return
        const detected = classifyProgressText(report.text ?? '')
        set((prev) => ({
          progress: report.progress ?? prev.progress,
          text: report.text ?? prev.text,
          mode: prev.mode === 'unknown' && detected ? detected : prev.mode,
        }))
      })
      if (get().loadEpoch !== epoch) return
      // Weights are in GPU memory but the WebGPU shader pipelines
      // haven't been compiled yet — that happens lazily on the first
      // chat.completions.create call and is what makes the user's
      // first message feel sluggish. Run a 1-token throwaway here so
      // those pipelines compile under the load banner instead of
      // under their real first message. Failures are non-fatal: log
      // and proceed; a broken engine will surface on the real send.
      set({
        progress: 1,
        mode: 'warming',
        text: 'Compiling GPU kernels…',
      })
      try {
        await warmupEngine(size)
      } catch (err) {
        console.warn('[llm] warmup failed; proceeding anyway', err)
      }
      if (get().loadEpoch !== epoch) return
      set({ loadingFor: null, loadedFor: size, progress: 1 })
      // Chime once weights are ready. May no-op if the AudioContext is
      // still suspended (no user gesture yet), but the load typically
      // straddles enough activity that it's live by this point.
      playSfx('success')
    } catch (err) {
      if (get().loadEpoch !== epoch) return
      console.error('model load failed', err)
      playSfx('error')
      set({
        loadingFor: null,
        loadedFor: null,
        error: toChatError(err),
      })
    }
  },

  clearError: () => set({ error: null }),

  retry: async () => {
    set({ loadedFor: null, error: null })
    await get().startLoad(DEFAULT_MODEL_SIZE)
  },

  clearCacheAndRetry: async () => {
    set({
      progress: 0,
      text: 'Clearing cache…',
      error: null,
      loadedFor: null,
    })
    unloadEngine()
    await clearWebLLMStorage()
    await get().startLoad(DEFAULT_MODEL_SIZE)
  },
}))

// Sync `loadedFor` with the engine's real lifecycle for *fatal*
// teardowns only — worker process crash or messageerror, where the
// engine genuinely can't serve another request without rebuilding.
// We deliberately skip:
//   - 'size-switch'  → startLoad is about to set loadedFor itself
//   - 'load-failed'  → startLoad's catch already sets error + null
//   - 'stale-engine' → streamChat fires this during its in-flight
//                      retry; nulling loadedFor mid-recovery locked
//                      the UI into "not ready" even after the retry
//                      produced a clean response
//   - 'device-lost'  → no longer wired from the worker (the diag
//                      postMessage that used to relay it clashed with
//                      WebLLM's onmessage handler and threw
//                      UnknownMessageKindError on every turn); falls
//                      under 'stale-engine' now via isStaleEngineError
setEngineDiscardListener((reason: DiscardReason) => {
  if (reason !== 'worker-error' && reason !== 'worker-messageerror') return
  const state = useLLMLoader.getState()
  if (state.loadedFor === null) return
  useLLMLoader.setState({
    loadedFor: null,
    error: {
      message:
        'The model worker crashed. The engine has been torn down — click Try again to reload.',
      name: 'EngineDiscarded',
    },
  })
})
