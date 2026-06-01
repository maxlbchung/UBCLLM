import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useConversations, type View } from '../store/conversations'
import { ROUTES, navigate } from '../lib/router'
import { playSfx } from '../lib/sfx'
import { APP_VERSION } from '../version'
import {
  CalendarIcon,
  ChatIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GradCapIcon,
  GraphIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  XIcon,
  type IconProps,
} from './icons'

// Home is no longer one of these — it's a separate route (no sidebar), reached
// via the dedicated Home button rendered above the tool list.
const TOOLS: {
  view: View
  label: string
  Icon: ComponentType<IconProps>
}[] = [
  { view: 'chat', label: 'Ask AI', Icon: ChatIcon },
  { view: 'lookup', label: 'Course Finder', Icon: SearchIcon },
  { view: 'prereq', label: 'Prerequisite Visualizer', Icon: GraphIcon },
  { view: 'planning', label: 'Degree Planner', Icon: GradCapIcon },
  { view: 'calendar', label: 'Calendar', Icon: CalendarIcon },
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

  // Easter-egg discovery now lives in EasterEggToast (mounted at the App
  // shell in App.tsx). It handles SFX, the popup, and corpus loading;
  // the persistent count is surfaced on the Other page.

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
    // Mirrors the expanded layout's vertical skeleton (same `p-3 gap-3`,
    // same per-row heights: h-9 new-chat, h-8 nav rows) so every control
    // sits at the exact same Y as its expanded counterpart and nothing
    // jumps when toggling. Dividers appear only where the expanded sidebar
    // has them: above the (here-empty) chat-history region, and the
    // full-bleed rule above the settings row.
    return (
      <aside className="w-12 shrink-0 flex flex-col bg-canvas border-r border-line py-3 px-2 gap-3 h-screen">
        <div className="flex items-center justify-center">
          <button
            onClick={() => {
              playSfx('expand')
              toggleSidebar()
            }}
            className="text-fg-muted hover:text-fg hover:bg-surface rounded p-1"
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <ChevronRightIcon className="w-4 h-4" />
          </button>
        </div>

        {/* New chat — square button, kept centered in the taller h-9 slot
            so its Y still matches the expanded new-chat row. */}
        <div className="h-9 flex items-center justify-center">
          <button
            onClick={() => {
              playSfx('click')
              newConversation()
            }}
            className="h-8 w-8 flex items-center justify-center rounded bg-accent hover:bg-accent-hover text-accent-fg"
            aria-label="New chat"
            title="New chat"
          >
            <PlusIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Page selectors — square buttons, each filling its h-8 slot so
            the Y matches the expanded tool rows. */}
        <div className="flex flex-col items-center gap-1">
          {TOOLS.map((t) => {
            const active = view === t.view
            return (
              <button
                key={t.view}
                onClick={() => {
                  if (view !== t.view) playSfx('tab')
                  setView(t.view)
                }}
                className={
                  'h-8 w-8 flex items-center justify-center rounded ' +
                  (active ? 'bg-surface-raised' : 'hover:bg-surface')
                }
                aria-label={t.label}
                aria-current={active ? 'page' : undefined}
                title={t.label}
              >
                <t.Icon className="w-4 h-4 text-accent" />
              </button>
            )
          })}
        </div>

        {/* Divider mirroring the expanded "Chat History" rule. */}
        <div className="border-t border-line" />

        {/* Stands in for the expanded history list so the settings row
            sinks to the bottom. */}
        <div className="flex-1" />

        {/* Full-bleed footer divider, matching the expanded `-mx-3` rule. */}
        <div className="-mx-2 border-t border-line" />

        {/* Settings */}
        <button
          type="button"
          onClick={() => {
            if (view !== 'other') playSfx('tab')
            setView('other')
          }}
          className={
            'self-center h-8 w-8 flex items-center justify-center rounded ' +
            (view === 'other' ? 'bg-surface-raised' : 'hover:bg-surface')
          }
          aria-label="Settings"
          aria-current={view === 'other' ? 'page' : undefined}
          title="Settings"
        >
          <SettingsIcon className="w-4 h-4 text-accent" />
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
            <button
              onClick={() => {
                playSfx('tab')
                navigate(ROUTES.home)
              }}
              className="flex items-center gap-2 rounded hover:opacity-80 shrink-0"
              aria-label="Back to home"
              title="Back to home"
            >
              <img
                src={`${import.meta.env.BASE_URL}logo.png`}
                alt="Reodite"
                className="h-5 w-5 shrink-0"
              />
              <h1 className="text-sm font-semibold tracking-wide">Reodite</h1>
            </button>
            <span className="text-[0.625rem] text-fg-faint truncate">
              AI Academic Assistance
            </span>
          </div>
          <button
            onClick={() => {
              playSfx('collapse')
              toggleSidebar()
            }}
            className="text-fg-muted hover:text-fg hover:bg-surface rounded p-1 shrink-0"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <ChevronLeftIcon className="w-4 h-4" />
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
              <t.Icon className="w-4 h-4 text-accent" />
              <span>{t.label}</span>
              {t.view === 'chat' && (
                <span className="ml-auto text-[0.5625rem] uppercase tracking-wider text-highlight font-mono">
                  BETA
                </span>
              )}
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
                    'text-fg-faint hover:text-fg ' +
                    (isRenaming
                      ? 'opacity-100 text-fg'
                      : 'opacity-0 group-hover:opacity-100')
                  }
                  aria-label="Rename conversation"
                  title="Rename"
                >
                  <PencilIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => openDeletePrompt(e, id)}
                  className={
                    'text-fg-faint hover:text-danger-fg ' +
                    (isPendingDelete
                      ? 'opacity-100 text-danger-fg'
                      : 'opacity-0 group-hover:opacity-100')
                  }
                  aria-label="Delete conversation"
                  aria-haspopup="dialog"
                  aria-expanded={isPendingDelete}
                >
                  <XIcon className="w-3.5 h-3.5" />
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
          <SettingsIcon className="w-4 h-4 text-accent" />
          <span>Settings</span>
        </button>
        {/* Footer line — version + copyright + license collapsed onto one
            row. PolyForm-NC is source-available but forbids commercial
            use; the License link points at LICENSE on GitHub since this
            is a static deploy with no local route. */}
        <div className="text-[0.625rem] text-fg-faint font-mono leading-relaxed">
          v{APP_VERSION} · © 2026 Max Chung ·{' '}
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
