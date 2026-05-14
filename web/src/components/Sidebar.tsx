import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useConversations, type View } from '../store/conversations'
import { useEasterEggs } from '../store/easterEggs'
import { playSfx } from '../lib/sfx'
import { APP_VERSION } from '../version'

const TOOLS: { view: View; label: string; icon: string }[] = [
  { view: 'chat', label: 'AI Chatbot', icon: '💬' },
  { view: 'lookup', label: 'Course Lookup', icon: '🔎' },
  { view: 'prereq', label: 'Prerequisite Tree', icon: '🌳' },
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
  const renameConversation = useConversations((s) => s.renameConversation)
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

  // Discovery animation sequence:
  //   t=0     rings fade in around the number (anticipation)
  //   t≈160   rings hold at full size, drawing attention
  //   t≈790   rings start zooming inward toward the number
  //   t=1100  IMPACT — number flips to new value + pops, sparks burst out
  //   t=1150  rings hit zero scale and vanish
  //   t≈3600  sparks finish (egg-spark = 2500ms)
  //
  // `displayedCount` is the value rendered in the counter — it lags
  // `discoveredCount` by 850ms so the visible flip lands on the impact
  // beat rather than the moment the store updates. Each burst gets its own
  // id so back-to-back discoveries can stack without one cancelling the
  // other.
  const [displayedCount, setDisplayedCount] = useState(discoveredCount)
  const [popKey, setPopKey] = useState(0)
  const [ringBursts, setRingBursts] = useState<{ id: number }[]>([])
  const [sparkBursts, setSparkBursts] = useState<
    { id: number; particles: { id: number; dx: number; dy: number }[] }[]
  >([])
  const prevCountRef = useRef(discoveredCount)
  // `initializedRef` gates the animation against the page-open false-positive.
  // validIds is not persisted (loadFromCorpus repopulates it on every mount),
  // so on every page open discoveredCount goes 0 (pre-load filter against
  // empty validIds) → N (post-load filter sees the persisted IDs). Without
  // this gate, that 0 → N transition reads as a new discovery and the
  // animation fires on load. We treat the first effect run with a populated
  // validIds as the baseline-snap: align prevCountRef + displayedCount, no
  // animation. Only subsequent increments animate.
  const initializedRef = useRef(false)
  // Discovery animation effect. Depends on discoveredCount and the loaded
  // state of validIds. Listing ringBursts.length here was the bug fixed in
  // v1.0.14: the Phase 1 setRingBursts caused a re-render → effect cleanup →
  // clearTimeout cascade that nuked the impact/ring/spark timers before they
  // fired. The "keep displayed in sync at rest" branch lives in a separate
  // effect below — it has no cleanup, so it can't tear this one's timers down.
  useEffect(() => {
    if (!initializedRef.current) {
      // Wait for loadFromCorpus to populate validIds before establishing
      // the baseline; until then discoveredCount is artificially 0.
      if (validIds.length > 0) {
        initializedRef.current = true
        prevCountRef.current = discoveredCount
        setDisplayedCount(discoveredCount)
      }
      return
    }
    if (discoveredCount <= prevCountRef.current) {
      prevCountRef.current = discoveredCount
      return
    }
    const burstId = Date.now()
    const targetCount = discoveredCount

    // Sound timeline runs in lockstep with the visual animation:
    //   t=0     eggFound  — quick rising sine as the rings fade in
    //   t=0     eggWind   — slow-attack pad that swells through the
    //                       rings-hold + rings-zoom phases
    //   t=1100  eggVictory — triumphant chord on impact (fired inside
    //                        the existing impactTimer below)
    // Found + wind start together: the wind has a 400 ms attack so its
    // volume is still near silence while the found chirp is at its
    // bright peak, then takes over as the found tails off.
    playSfx('eggFound')
    playSfx('eggWind')

    // Phase 1: rings appear
    setRingBursts((b) => [...b, { id: burstId }])

    // Phase 2: impact. Snap the number, pop, fire sparks.
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
    const impactTimer = window.setTimeout(() => {
      setDisplayedCount(targetCount)
      setPopKey((k) => k + 1)
      setSparkBursts((b) => [...b, { id: burstId, particles }])
      // Synced to the visual impact: number snap + sparks + chord all
      // land on the same frame, so the chord reads as the cause rather
      // than a follow-up beat.
      playSfx('eggVictory')
    }, 1100)

    // Phase 3: ring cleanup just after they vanish.
    const ringTimer = window.setTimeout(() => {
      setRingBursts((b) => b.filter((x) => x.id !== burstId))
    }, 1200)

    // Phase 4: spark cleanup after they finish (impact + 2500ms run + buffer).
    const sparkTimer = window.setTimeout(() => {
      setSparkBursts((b) => b.filter((x) => x.id !== burstId))
    }, 1100 + 2700)

    prevCountRef.current = discoveredCount
    return () => {
      window.clearTimeout(impactTimer)
      window.clearTimeout(ringTimer)
      window.clearTimeout(sparkTimer)
    }
  }, [discoveredCount, validIds.length])

  // Keep the displayed count in sync when no animation is running (e.g.
  // initial hydration from localStorage, or a count that decreased because
  // validIds shrank between deploys). No cleanup function so it can't
  // interfere with the discovery effect's timers.
  useEffect(() => {
    if (discoveredCount !== displayedCount && ringBursts.length === 0) {
      setDisplayedCount(discoveredCount)
    }
  }, [discoveredCount, displayedCount, ringBursts.length])

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

  // Inline-rename state. We keep the draft separate from the persisted title
  // so an Escape cancels cleanly without rewriting the store.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)


  function startRename(e: MouseEvent<HTMLButtonElement>, id: string) {
    e.stopPropagation()
    closeDeletePrompt()
    const conv = conversations[id]
    if (!conv) return
    playSfx('click')
    setRenamingId(id)
    setRenameDraft(conv.title)
  }

  function commitRename() {
    if (renamingId) {
      renameConversation(renamingId, renameDraft)
      playSfx('success')
    }
    setRenamingId(null)
    setRenameDraft('')
  }

  function cancelRename() {
    if (renamingId) playSfx('click')
    setRenamingId(null)
    setRenameDraft('')
  }

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

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
    playSfx('click')
  }

  function closeDeletePrompt() {
    setPendingDeleteId(null)
    setPopupPos(null)
  }

  function confirmDelete() {
    if (pendingDeleteId) {
      playSfx('delete')
      deleteConversation(pendingDeleteId)
    }
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
      <aside className="w-12 shrink-0 flex flex-col items-center bg-canvas border-r border-line py-3 gap-2 h-screen">
        <button
          onClick={() => {
            playSfx('expand')
            toggleSidebar()
          }}
          className="text-fg-muted hover:text-fg hover:bg-surface rounded p-1.5 text-base leading-none"
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
      <aside className="w-72 shrink-0 flex flex-col bg-canvas border-r border-line p-3 gap-3 h-screen">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <img
              src={`${import.meta.env.BASE_URL}logo.png`}
              alt="Reodite"
              className="h-5 w-5 shrink-0"
            />
            <h1 className="text-sm font-semibold tracking-wide">Reodite</h1>
            <span className="text-[0.625rem] text-fg-faint">AI Academic Assistance</span>
          </div>
          <button
            onClick={() => {
              playSfx('collapse')
              toggleSidebar()
            }}
            className="text-fg-muted hover:text-fg hover:bg-surface rounded p-1 text-base leading-none shrink-0"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            ◀
          </button>
        </div>

        <button
          onClick={() => {
            playSfx('click')
            newConversation()
          }}
          className="rounded bg-accent hover:bg-accent-hover text-accent-fg text-sm font-medium py-2"
        >
          + New chat
        </button>

        <div className="flex flex-col gap-1">
          {TOOLS.map((t) => (
            <button
              key={t.view}
              onClick={() => {
                if (view !== t.view) playSfx('tab')
                setView(t.view)
              }}
              className={
                'flex items-center gap-2 rounded px-2 py-1.5 text-sm text-left ' +
                (view === t.view
                  ? 'bg-surface-raised text-fg'
                  : 'text-fg-muted hover:bg-surface hover:text-fg')
              }
            >
              <span aria-hidden>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        <div className="border-t border-line pt-2 text-[0.6875rem] uppercase tracking-wider text-fg-faint">
          Chat History
        </div>

        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1">
          {order.length === 0 && (
            <p className="text-xs text-fg-faint px-2">No conversations yet.</p>
          )}
          {order.map((id) => {
            const conv = conversations[id]
            if (!conv) return null
            const isActive = id === activeId && view === 'chat'
            const isPendingDelete = id === pendingDeleteId
            const isRenaming = id === renamingId
            return (
              <div
                key={id}
                data-conv-row
                className={
                  'group flex items-center gap-1 rounded px-2 py-1.5 text-sm ' +
                  (isRenaming ? '' : 'cursor-pointer ') +
                  (isActive
                    ? 'bg-surface-raised text-fg'
                    : isPendingDelete
                      ? 'bg-surface text-fg ring-1 ring-danger/40'
                      : 'text-fg-muted hover:bg-surface')
                }
                onClick={() => {
                  if (isRenaming) return
                  // setActive switches to the chat view even when the
                  // clicked id is already the activeId, so the click
                  // SFX has to fire whenever EITHER the active chat is
                  // changing OR the view is leaving a non-chat tool to
                  // come back to chat. Without the view check, clicking
                  // back into the previously-open conversation from
                  // Lookup / Prereq / Other plays silently.
                  if (id !== activeId || view !== 'chat') playSfx('click')
                  setActive(id)
                }}
              >
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitRename()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelRename()
                      }
                    }}
                    onBlur={commitRename}
                    maxLength={120}
                    className="flex-1 min-w-0 bg-canvas border border-line-soft rounded px-1.5 py-0.5 text-sm text-fg focus:outline-none focus:border-accent-hover"
                  />
                ) : (
                  <span className="flex-1 truncate">{conv.title}</span>
                )}
                <button
                  onClick={(e) => startRename(e, id)}
                  className={
                    'text-fg-faint hover:text-fg text-xs ' +
                    (isRenaming
                      ? 'opacity-100 text-fg'
                      : 'opacity-0 group-hover:opacity-100')
                  }
                  aria-label="Rename conversation"
                  title="Rename"
                >
                  ✎
                </button>
                <button
                  onClick={(e) => openDeletePrompt(e, id)}
                  className={
                    'text-fg-faint hover:text-danger-fg text-xs ' +
                    (isPendingDelete
                      ? 'opacity-100 text-danger-fg'
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

        {/* Divider line above the settings row, separating the footer cluster
            (settings + version) from the scrollable chat history above.
            `-mx-3` cancels the sidebar's `p-3` so the rule spans edge to
            edge. */}
        <div className="-mx-3 border-t border-line" />
        <button
          type="button"
          onClick={() => {
            if (view !== 'other') playSfx('tab')
            setView('other')
          }}
          className={
            'flex items-center gap-2 rounded px-2 py-1.5 text-sm text-left w-full ' +
            (view === 'other'
              ? 'bg-surface-raised text-fg'
              : 'text-fg-muted hover:bg-surface hover:text-fg')
          }
        >
          <span aria-hidden>⚙</span>
          <span>Other</span>
        </button>
        <div className="flex items-center justify-between text-[0.625rem] font-mono">
          <span className="text-fg-faint">v{APP_VERSION}</span>
          <span
            className="text-highlight-fg"
            title={
              eggTotal > 0
                ? `${discoveredCount} of ${eggTotal} easter eggs discovered`
                : 'Easter eggs (loading…)'
            }
          >
            {/* Inner relative wrapper anchors the rings + sparks to just the
                numbers, not the whole "N/total Easter Eggs Found" line. */}
            <span className="relative inline-block">
              {/* key={popKey} remounts the span so the egg-pop keyframe
                  restarts on each impact. Without remount, replaying the
                  same animation on the same element is a no-op. */}
              <span
                key={popKey}
                className="inline-block origin-center"
                style={{
                  animation: popKey > 0 ? 'egg-pop 450ms ease-out' : undefined,
                }}
              >
                {displayedCount}/{eggTotal || '–'}
              </span>
              {/* Anticipation rings — three same-size circles staggered by
                  100ms / 150ms so they pulse out one after another rather
                  than animating concentrically. Sized in rem so they scale
                  with the rem-base setting in index.css. The glow color
                  is derived from --highlight-fg via color-mix so it tints
                  per theme without needing a separate token. */}
              {ringBursts.map((burst) => (
                <span
                  key={burst.id}
                  aria-hidden
                  className="pointer-events-none absolute left-1/2 top-1/2"
                >
                  {[0, 100, 150].map((delayMs, i) => (
                    <span
                      key={i}
                      className="absolute left-0 top-0 rounded-full border-2 border-highlight-fg"
                      style={{
                        width: '4.2rem',
                        height: '4.2rem',
                        boxShadow:
                          '0 0 6px 1px color-mix(in oklab, var(--highlight-fg) 50%, transparent)',
                        animation: 'egg-ring 1150ms linear forwards',
                        animationDelay: `${delayMs}ms`,
                      }}
                    />
                  ))}
                </span>
              ))}
              {sparkBursts.map((burst) => (
                <span
                  key={burst.id}
                  aria-hidden
                  className="pointer-events-none absolute inset-0"
                >
                  {burst.particles.map((p) => (
                    <span
                      key={p.id}
                      className="absolute left-1/2 top-1/2 h-2 w-2 rounded-full bg-highlight-fg"
                      style={
                        {
                          '--dx': `${p.dx}px`,
                          '--dy': `${p.dy}px`,
                          boxShadow:
                            '0 0 8px 2px color-mix(in oklab, var(--highlight-fg) 80%, transparent)',
                          animation:
                            'egg-spark 2500ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
                        } as React.CSSProperties
                      }
                    />
                  ))}
                </span>
              ))}
            </span>
            <span> Easter Eggs Found</span>
          </span>
        </div>
        {/* Copyright + license link. PolyForm-NC is source-available but
            forbids commercial use; surfaced here so visitors don't have to
            dig through the repo to find the terms. Link points to the
            LICENSE on GitHub since this is a static deploy with no
            local route. */}
        <div className="text-[0.625rem] text-fg-faint font-mono leading-relaxed">
          © 2026 Max Chung ·{' '}
          <a
            href="https://github.com/maxlbchung/UBCLLM/blob/master/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            className="text-link hover:underline"
          >
            License
          </a>
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
            className="fixed z-50 bg-surface border border-line-soft rounded-md shadow-lg shadow-black/40 p-2.5 flex flex-col gap-2"
          >
            <p className="text-xs text-fg-muted leading-snug">
              Delete{' '}
              <span className="font-semibold text-fg">
                "{pendingConv.title}"
              </span>
              ?
            </p>
            <div className="flex gap-1.5 justify-end">
              <button
                onClick={() => {
                  playSfx('click')
                  closeDeletePrompt()
                }}
                className="text-xs px-2 py-1 rounded bg-surface-raised hover:bg-line-soft text-fg"
                autoFocus
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="text-xs px-2 py-1 rounded bg-danger hover:bg-danger-hover text-accent-fg font-medium"
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
