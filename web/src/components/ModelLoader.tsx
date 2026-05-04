import { useEffect, useState, type ReactNode } from 'react'
import { getLLM } from '../lib/llm'
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

interface State {
  progress: number
  text: string
  ready: boolean
  error: ChatError | null
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
          setS((prev) => ({
            ...prev,
            progress: report.progress ?? prev.progress,
            text: report.text ?? prev.text,
          }))
        })
        if (!cancelled) setS((prev) => ({ ...prev, ready: true, progress: 1 }))
      } catch (err) {
        if (!cancelled) {
          console.error('model load failed', err)
          setS((prev) => ({ ...prev, error: toChatError(err) }))
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [retryKey])

  function retry() {
    setS({ progress: 0, text: 'Retrying…', ready: false, error: null })
    setRetryKey((k) => k + 1)
  }

  async function clearCacheAndRetry() {
    setS({ progress: 0, text: 'Clearing cache…', ready: false, error: null })
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
                  onClick={() => void clearCacheAndRetry()}
                  className="px-4 py-2 rounded-md bg-blue-500 hover:bg-blue-400 text-white text-sm font-medium transition-colors"
                >
                  Clear cache and try again
                </button>
                <button
                  type="button"
                  onClick={retry}
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
              UBCLLM needs WebGPU and ~2 GB of memory. Try Chrome 113+ or Edge 113+ on a desktop with a recent GPU.
            </p>
          )}
        </div>
        <VersionBadge />
      </>
    )
  }

  if (!s.ready) {
    return (
      <>
        <div className="flex flex-col items-center justify-center h-screen p-8 gap-4">
          <h2 className="text-xl font-semibold">Loading Gemma 4 E2B</h2>
          <div className="w-full max-w-md h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all"
              style={{ width: `${Math.round(s.progress * 100)}%` }}
            />
          </div>
          <p className="text-xs text-zinc-400 max-w-md text-center">{s.text}</p>
          <p className="text-[0.6875rem] text-zinc-500 max-w-md text-center">
            First load downloads the model (~1–2 GB). It's cached in your browser, so the next visit starts instantly.
          </p>
        </div>
        <VersionBadge />
      </>
    )
  }

  return <>{children}</>
}
