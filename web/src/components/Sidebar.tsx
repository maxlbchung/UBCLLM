import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useConversations, type View } from '../store/conversations'
import { useEasterEggs } from '../store/easterEggs'
import { APP_VERSION } from '../version'

const TOOLS: { view: View; label: string; icon: string }[] = [
  { view: 'chat', label: 'Chat', icon: '💬' },
  { view: 'lookup', label: 'Course lookup', icon: '🔎' },
  { view: 'prereq', label: 'Prereq tree', icon: '🌳' },
]

const POPUP_WIDTH = 224 // px; matches Tailwind's w-56

export function Sidebar() {
  const conversations = useConversations((s) => s.conversations)
  const order = useConversations((s) => s.order)
  const activeId = useConversations((s) => s.activeId)
  const view = useConversations((s) => s.view)
  const collapsed = useConversations((s) => s.sidebarCollapsed)
  const newConversation = useConversations((s) => s.newConversation)
  const setActive = useConversations((s) => s.setActive)
  const deleteConversation = useConversations((s) => s.deleteConversation)
  const setView = useConversations((s) => s.setView)
  const toggleSidebar = useConversations((s) => s.toggleSidebar)

  // Easter-egg counter (bottom-right). Total comes from the live corpus so
  // adding/removing eggs in the pipeline reflects on next session without
  // any migration. The corpus is shared via a cached promise in retrieve.ts,
  // so this just attaches to whatever load is already in flight (or kicks
  // one off if the user opened the sidebar before sending a message).
  const discovered = useEasterEggs((s) => s.discovered)
  const validIds = useEasterEggs((s) => s.validIds)
  const loadFromCorpus = useEasterEggs((s) => s.loadFromCorpus)
  useEffect(() => {
    void loadFromCorpus()
  }, [loadFromCorpus])
  const validIdSet = new Set(validIds)
  const discoveredCount = discovered.filter((id) => validIdSet.has(id)).length
  const eggTotal = validIds.length

  // Pop + spark burst when discoveredCount increments. `popKey` is bumped to
  // remount the counter span so the CSS keyframe restarts; sparkBursts is a
  // queue of {id, particles[]} so multiple back-to-back discoveries can
  // overlap without one wiping out the other. Each burst is 12 particles
  // along an 8-spoke ring with a small per-particle angular jitter and
  // distance jitter so the spread looks organic, not mechanical.
  const [popKey, setPopKey] = useState(0)
  const [sparkBursts, setSparkBursts] = useState<
    { id: number; particles: { id: number; dx: number; dy: number }[] }[]
  >([])
  const prevCountRef = useRef(discoveredCount)
  useEffect(() => {
    if (discoveredCount > prevCountRef.current && prevCountRef.current >= 0) {
      // Skip the initial-load delta from 0→N when persisted state hydrates
      // and the corpus arrives — we only want to celebrate live discoveries.
      // The prev ref is initialized to discoveredCount at first mount, so
      // this branch only fires on subsequent increments.
      const burstId = Date.now()
      const PARTICLE_COUNT = 28
      const particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => {
        const baseAngle = (Math.PI * 2 * i) / PARTICLE_COUNT
        const angle = baseAngle + (Math.random() - 0.5) * 0.5
        const distance = 70 + Math.random() * 50
        return {
          id: burstId + i,
          dx: Math.cos(angle) * distance,
          dy: Math.sin(angle) * distance,
        }
      })
      setPopKey((k) => k + 1)
      setSparkBursts((b) => [...b, { id: burstId, particles }])
      // egg-spark keyframe runs 2500ms; give it a small buffer before
      // dropping the detached nodes from React state.
      const t = window.setTimeout(() => {
        setSparkBursts((b) => b.filter((x) => x.id !== burstId))
      }, 2700)
      prevCountRef.current = discoveredCount
      return () => window.clearTimeout(t)
    }
    prevCountRef.current = discoveredCount
  }, [discoveredCount])

  // Inline delete-confirmation popup. Replaces window.confirm() so we get a
  // styled prompt anchored to the row rather than a system dialog. We anchor
  // by viewport coords (computed via the row's getBoundingClientRect on the
  // X-button click) and render through a portal so the sidebar's
  // overflow-y-auto can't clip the popup.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [popupPos, setPopupPos] = useState<{ top: number; left: number } | null>(
    null,
  )
  const popupRef = useRef<HTMLDivElement | null>(null)

  function openDeletePrompt(e: MouseEvent<HTMLButtonElement>, id: string) {
    e.stopPropagation()
    const row = e.currentTarget.closest<HTMLElement>('[data-conv-row]')
    if (!row) return
    const rect = row.getBoundingClientRect()
    setPopupPos({
      top: rect.top,
      // Pin to the right of the row but keep the popup on-screen if the
      // sidebar is wide enough that flowing right would overflow.
      left: Math.min(rect.right + 8, window.innerWidth - POPUP_WIDTH - 8),
    })
    setPendingDeleteId(id)
  }

  function closeDeletePrompt() {
    setPendingDeleteId(null)
    setPopupPos(null)
  }

  function confirmDelete() {
    if (pendingDeleteId) deleteConversation(pendingDeleteId)
    closeDeletePrompt()
  }

  // Dismiss on outside-click, Escape, or scroll/resize (the popup is anchored
  // by absolute coords; if the row moves, repositioning is more work than
  // just closing and letting the user click X again).
  useEffect(() => {
    if (!pendingDeleteId) return
    function onMouseDown(ev: globalThis.MouseEvent) {
      if (popupRef.current?.contains(ev.target as Node)) return
      closeDeletePrompt()
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') closeDeletePrompt()
    }
    function onShift() {
      closeDeletePrompt()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onShift)
    // capture: catch scrolls inside the history list, not just window-level.
    window.addEventListener('scroll', onShift, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onShift)
      window.removeEventListener('scroll', onShift, true)
    }
  }, [pendingDeleteId])

  if (collapsed) {
    return (
      <aside className="w-12 shrink-0 flex flex-col items-center bg-zinc-950 border-r border-zinc-800 py-3 gap-2 h-screen">
        <button
          onClick={toggleSidebar}
          className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 rounded p-1.5 text-base leading-none"
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          ▶
        </button>
      </aside>
    )
  }

  const pendingConv = pendingDeleteId ? conversations[pendingDeleteId] : null

  return (
    <>
      <aside className="w-72 shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800 p-3 gap-3 h-screen">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2 min-w-0">
            <h1 className="text-sm font-semibold tracking-wide">UBCLLM</h1>
            <span className="text-[0.625rem] text-zinc-500">in-browser</span>
          </div>
          <button
            onClick={toggleSidebar}
            className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 rounded p-1 text-base leading-none shrink-0"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            ◀
          </button>
        </div>

        <button
          onClick={() => newConversation()}
          className="rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium py-2"
        >
          + New chat
        </button>

        <div className="flex flex-col gap-1">
          {TOOLS.map((t) => (
            <button
              key={t.view}
              onClick={() => setView(t.view)}
              className={
                'flex items-center gap-2 rounded px-2 py-1.5 text-sm text-left ' +
                (view === t.view
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200')
              }
            >
              <span aria-hidden>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        <div className="border-t border-zinc-800 pt-2 text-[0.6875rem] uppercase tracking-wider text-zinc-500">
          History
        </div>

        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1">
          {order.length === 0 && (
            <p className="text-xs text-zinc-500 px-2">No conversations yet.</p>
          )}
          {order.map((id) => {
            const conv = conversations[id]
            if (!conv) return null
            const isActive = id === activeId && view === 'chat'
            const isPendingDelete = id === pendingDeleteId
            return (
              <div
                key={id}
                data-conv-row
                className={
                  'group flex items-center gap-1 rounded px-2 py-1.5 text-sm cursor-pointer ' +
                  (isActive
                    ? 'bg-zinc-800 text-zinc-100'
                    : isPendingDelete
                      ? 'bg-zinc-900 text-zinc-200 ring-1 ring-red-500/40'
                      : 'text-zinc-300 hover:bg-zinc-900')
                }
                onClick={() => setActive(id)}
              >
                <span className="flex-1 truncate">{conv.title}</span>
                <button
                  onClick={(e) => openDeletePrompt(e, id)}
                  className={
                    'text-zinc-500 hover:text-red-400 text-xs ' +
                    (isPendingDelete
                      ? 'opacity-100 text-red-400'
                      : 'opacity-0 group-hover:opacity-100')
                  }
                  aria-label="Delete conversation"
                  aria-haspopup="dialog"
                  aria-expanded={isPendingDelete}
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>

        <div className="text-[0.625rem] text-zinc-600 leading-tight">
          Gemma 4 E2B · WebGPU · MiniLM embeddings · UBC Vancouver calendar 2026/27.
        </div>
        <div className="flex items-center justify-between text-[0.625rem] font-mono">
          <span className="text-zinc-500">v{APP_VERSION}</span>
          <span
            className="relative inline-block text-amber-300"
            title={
              eggTotal > 0
                ? `${discoveredCount} of ${eggTotal} easter eggs discovered`
                : 'Easter eggs (loading…)'
            }
          >
            {/* key={popKey} remounts the span so the egg-pop keyframe restarts
                each time the count ticks up. Without remount, replaying the
                same animation on the same element is a no-op. */}
            <span
              key={popKey}
              className="inline-block origin-center"
              style={{
                animation: popKey > 0 ? 'egg-pop 450ms ease-out' : undefined,
              }}
            >
              {discoveredCount}/{eggTotal || '–'}
            </span>
            {sparkBursts.map((burst) => (
              <span
                key={burst.id}
                aria-hidden
                className="pointer-events-none absolute inset-0"
              >
                {burst.particles.map((p) => (
                  <span
                    key={p.id}
                    className="absolute left-1/2 top-1/2 h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_8px_2px_rgba(252,211,77,0.8)]"
                    style={
                      {
                        '--dx': `${p.dx}px`,
                        '--dy': `${p.dy}px`,
                        animation:
                          'egg-spark 2500ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
                      } as React.CSSProperties
                    }
                  />
                ))}
              </span>
            ))}
          </span>
        </div>
      </aside>

      {pendingConv &&
        popupPos &&
        createPortal(
          <div
            ref={popupRef}
            role="dialog"
            aria-label="Delete conversation"
            style={{ top: popupPos.top, left: popupPos.left, width: POPUP_WIDTH }}
            className="fixed z-50 bg-zinc-900 border border-zinc-700 rounded-md shadow-lg shadow-black/40 p-2.5 flex flex-col gap-2"
          >
            <p className="text-xs text-zinc-300 leading-snug">
              Delete{' '}
              <span className="font-semibold text-zinc-100">
                "{pendingConv.title}"
              </span>
              ?
            </p>
            <div className="flex gap-1.5 justify-end">
              <button
                onClick={closeDeletePrompt}
                className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                autoFocus
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="text-xs px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-medium"
              >
                Delete
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
