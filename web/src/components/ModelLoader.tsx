import { useEffect, useState, type ReactNode } from 'react'
import { getLLM } from '../lib/llm'
import { playSfx } from '../lib/sfx'
import type { ChatError } from '../store/chat'
import { APP_VERSION } from '../version'
import { ErrorDetails } from './ErrorDetails'

function VersionBadge() {
  return (
    <div className="fixed bottom-2 left-3 text-[0.6875rem] text-zinc-500 font-mono pointer-events-none select-none">
      v{APP_VERSION}
    </div>
  )
}

// 'unknown' until WebLLM's first progress tick classifies the load. We
// stick to the first detected mode for the rest of the load — the very
// last tick on both paths is "Finish loading on WebGPU", which would
// otherwise erase the cold/warm distinction we just learned.
type LoadMode = 'unknown' | 'cold' | 'warm'

interface State {
  progress: number
  text: string
  ready: boolean
  error: ChatError | null
  mode: LoadMode
}

// WebLLM's InitProgressReport.text is the only signal we get for
// download-vs-cache: "Fetching param cache[i/n]: …" on a fresh download
// and "Loading model from cache[i/n]: …" on a warm IndexedDB hit. Both
// strings are emitted by web-llm's cache_util.ts and are stable enough
// to match on.
function classifyProgressText(text: string): LoadMode | null {
  if (/fetching param cache/i.test(text)) return 'cold'
  if (/loading model from cache/i.test(text)) return 'warm'
  return null
}

function toChatError(err: unknown): ChatError {
  const isErrInstance = err instanceof Error
  return {
    message: isErrInstance ? err.message : String(err),
    name: isErrInstance ? err.name : undefined,
    stack: isErrInstance ? err.stack : undefined,
  }
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

export function ModelLoader({ children }: { children: ReactNode }) {
  const [s, setS] = useState<State>({
    progress: 0,
    text: 'Initializing…',
    ready: false,
    error: null,
    mode: 'unknown',
  })
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let cancelled = false

    if (typeof navigator !== 'undefined' && !('gpu' in navigator)) {
      setS((prev) => ({
        ...prev,
        error: {
          name: 'WebGPUUnavailable',
          message:
            'WebGPU is not available in this browser. Use Chrome or Edge 113+ on a desktop.',
        },
      }))
      return
    }

    void (async () => {
      try {
        await getLLM((report) => {
          if (cancelled) return
          const detected = classifyProgressText(report.text ?? '')
          setS((prev) => ({
            ...prev,
            progress: report.progress ?? prev.progress,
            text: report.text ?? prev.text,
            // Sticky: only upgrade from unknown. Once we know it's a
            // cold or warm load we keep that classification through
            // the final "Finish loading on WebGPU" tick.
            mode: prev.mode === 'unknown' && detected ? detected : prev.mode,
          }))
        })
        if (!cancelled) {
          setS((prev) => ({ ...prev, ready: true, progress: 1 }))
          // Chime once the model finishes loading. May no-op if AudioContext
          // is still suspended (no user gesture yet), but that's expected —
          // the load typically straddles enough user activity that the
          // context is live by the time this fires.
          playSfx('success')
        }
      } catch (err) {
        if (!cancelled) {
          console.error('model load failed', err)
          playSfx('error')
          setS((prev) => ({ ...prev, error: toChatError(err) }))
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [retryKey])

  function retry() {
    setS({ progress: 0, text: 'Retrying…', ready: false, error: null, mode: 'unknown' })
    setRetryKey((k) => k + 1)
  }

  async function clearCacheAndRetry() {
    setS({ progress: 0, text: 'Clearing cache…', ready: false, error: null, mode: 'unknown' })
    await clearWebLLMStorage()
    setRetryKey((k) => k + 1)
  }

  if (s.error) {
    const isNetworkError = /cache|network|fetch/i.test(s.error.message)
    return (
      <>
        <div className="flex flex-col items-center justify-center h-screen p-8 gap-3 text-center">
          <h2 className="text-xl font-semibold text-red-400">Couldn't load the model</h2>
          <div className="max-w-xl w-full text-left">
            <ErrorDetails error={s.error} />
          </div>
          {isNetworkError ? (
            <>
              <div className="flex flex-col items-center gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    playSfx('click')
                    void clearCacheAndRetry()
                  }}
                  className="px-4 py-2 rounded-md bg-blue-500 hover:bg-blue-400 text-white text-sm font-medium transition-colors"
                >
                  Clear cache and try again
                </button>
                <button
                  type="button"
                  onClick={() => {
                    playSfx('click')
                    retry()
                  }}
                  className="text-sm text-zinc-400 hover:text-zinc-200 hover:underline underline-offset-2"
                >
                  Try again
                </button>
              </div>
              <p className="text-[0.6875rem] text-zinc-500 max-w-md mt-2">
                A persistent failure usually means a corrupted cached shard from an earlier interrupted download. Clearing the cache forces a clean re-download.
              </p>
            </>
          ) : (
            <p className="text-xs text-zinc-500 max-w-md">
              Reodite needs WebGPU and ~2.5 GB of GPU memory. Try Chrome 113+ or Edge 113+ on a desktop with a recent GPU.
            </p>
          )}
        </div>
        <VersionBadge />
      </>
    )
  }

  if (!s.ready) {
    // Heading: switch to "Loading from cache" once we know the weights are
    // already in IndexedDB, so a returning user immediately sees that this
    // isn't another ~1 GB download. Stays as "Loading Qwen3.5 2B" for
    // both unknown (pre-classification) and cold paths — the cold caption
    // below already calls out the download size.
    const heading =
      s.mode === 'warm' ? 'Loading Qwen3.5 2B from cache' : 'Loading Qwen3.5 2B'
    const caption =
      s.mode === 'warm'
        ? 'Reusing the model weights cached in your browser from a previous visit — no re-download needed.'
        : "First load downloads the model (~1 GB). It's cached in your browser, so the next visit starts instantly."
    return (
      <>
        <div className="flex flex-col items-center justify-center h-screen p-8 gap-4">
          <h2 className="text-xl font-semibold">{heading}</h2>
          <div className="w-full max-w-md h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all"
              style={{ width: `${Math.round(s.progress * 100)}%` }}
            />
          </div>
          <p className="text-xs text-zinc-400 max-w-md text-center">{s.text}</p>
          <p className="text-[0.6875rem] text-zinc-500 max-w-md text-center">{caption}</p>
        </div>
        <VersionBadge />
      </>
    )
  }

  return <>{children}</>
}
