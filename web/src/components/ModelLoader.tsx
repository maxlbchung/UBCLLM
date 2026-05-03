import { useEffect, useState, type ReactNode } from 'react'
import { getLLM } from '../lib/llm'

interface State {
  progress: number
  text: string
  ready: boolean
  error: string | null
}

export function ModelLoader({ children }: { children: ReactNode }) {
  const [s, setS] = useState<State>({
    progress: 0,
    text: 'Initializing…',
    ready: false,
    error: null,
  })

  useEffect(() => {
    let cancelled = false

    if (typeof navigator !== 'undefined' && !('gpu' in navigator)) {
      setS((prev) => ({
        ...prev,
        error:
          'WebGPU is not available in this browser. Use Chrome or Edge 113+ on a desktop.',
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
          setS((prev) => ({ ...prev, error: (err as Error).message }))
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  if (s.error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen p-8 gap-3 text-center">
        <h2 className="text-xl font-semibold text-red-400">Couldn't load the model</h2>
        <p className="text-sm text-zinc-400 max-w-md">{s.error}</p>
        <p className="text-xs text-zinc-500 max-w-md">
          UBCLLM needs WebGPU and ~2 GB of memory. Try Chrome 113+ or Edge 113+ on a desktop with a recent GPU.
        </p>
      </div>
    )
  }

  if (!s.ready) {
    return (
      <div className="flex flex-col items-center justify-center h-screen p-8 gap-4">
        <h2 className="text-xl font-semibold">Loading Gemma 4 E2B</h2>
        <div className="w-full max-w-md h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${Math.round(s.progress * 100)}%` }}
          />
        </div>
        <p className="text-xs text-zinc-400 max-w-md text-center">{s.text}</p>
        <p className="text-[11px] text-zinc-500 max-w-md text-center">
          First load downloads the model (~1–2 GB). It's cached in your browser, so the next visit starts instantly.
        </p>
      </div>
    )
  }

  return <>{children}</>
}
