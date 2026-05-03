import { useConversations, type View } from '../store/conversations'
import { APP_VERSION } from '../version'

const TOOLS: { view: View; label: string; icon: string }[] = [
  { view: 'chat', label: 'Chat', icon: '💬' },
  { view: 'lookup', label: 'Course lookup', icon: '🔎' },
  { view: 'prereq', label: 'Prereq tree', icon: '🌳' },
]

export function Sidebar() {
  const conversations = useConversations((s) => s.conversations)
  const order = useConversations((s) => s.order)
  const activeId = useConversations((s) => s.activeId)
  const view = useConversations((s) => s.view)
  const newConversation = useConversations((s) => s.newConversation)
  const setActive = useConversations((s) => s.setActive)
  const deleteConversation = useConversations((s) => s.deleteConversation)
  const setView = useConversations((s) => s.setView)

  return (
    <aside className="w-64 shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800 p-3 gap-3 h-screen">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold tracking-wide">UBCLLM</h1>
        <span className="text-[10px] text-zinc-500">in-browser</span>
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

      <div className="border-t border-zinc-800 pt-2 text-[11px] uppercase tracking-wider text-zinc-500">
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
          return (
            <div
              key={id}
              className={
                'group flex items-center gap-1 rounded px-2 py-1.5 text-sm cursor-pointer ' +
                (isActive
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-300 hover:bg-zinc-900')
              }
              onClick={() => setActive(id)}
            >
              <span className="flex-1 truncate">{conv.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`Delete "${conv.title}"?`)) deleteConversation(id)
                }}
                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 text-xs"
                aria-label="Delete conversation"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>

      <div className="text-[10px] text-zinc-600 leading-tight">
        Gemma 4 E2B · WebGPU · MiniLM embeddings · UBC Vancouver calendar 2026/27.
      </div>
      <div className="text-[10px] text-zinc-500 font-mono">v{APP_VERSION}</div>
    </aside>
  )
}
