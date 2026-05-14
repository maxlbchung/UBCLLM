// Conversation list + active-view state, persisted to localStorage so users
// can refresh without losing their advisor history. The "current" message list
// lives in `useChat`; this store snapshots it onto the active conversation
// after each turn (Chat.tsx calls saveCurrent() when streaming completes).
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { useChat, type Message } from './chat'

export type View = 'chat' | 'lookup' | 'prereq'

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
}

interface State {
  conversations: Record<string, Conversation>
  order: string[] // newest first
  activeId: string | null
  view: View
  sidebarCollapsed: boolean

  newConversation: () => string
  setActive: (id: string) => void
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  setView: (v: View) => void
  saveCurrent: () => void
  ensureActive: () => string
  toggleSidebar: () => void
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2)
}

function deriveTitle(messages: Message[]): string | null {
  const first = messages.find(
    (m) => m.role === 'user' && m.content.trim().length > 0,
  )
  if (!first) return null
  const t = first.content.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? t.slice(0, 57) + '…' : t
}

export const useConversations = create<State>()(
  persist(
    (set, get) => ({
      conversations: {},
      order: [],
      activeId: null,
      view: 'chat',
      sidebarCollapsed: false,

      newConversation: () => {
        const id = newId()
        const conv: Conversation = {
          id,
          title: 'New chat',
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        set((s) => ({
          conversations: { ...s.conversations, [id]: conv },
          order: [id, ...s.order.filter((x) => x !== id)],
          activeId: id,
          view: 'chat',
        }))
        useChat.setState({ messages: [], streaming: false })
        return id
      },

      setActive: (id) => {
        const conv = get().conversations[id]
        if (!conv) return
        set({ activeId: id, view: 'chat' })
        useChat.setState({ messages: conv.messages, streaming: false })
      },

      deleteConversation: (id) => {
        const { conversations, order, activeId } = get()
        const next = { ...conversations }
        delete next[id]
        const nextOrder = order.filter((x) => x !== id)
        let nextActive = activeId
        if (activeId === id) {
          nextActive = nextOrder[0] ?? null
          const target = nextActive ? next[nextActive] : null
          useChat.setState({
            messages: target?.messages ?? [],
            streaming: false,
          })
        }
        set({
          conversations: next,
          order: nextOrder,
          activeId: nextActive,
        })
      },

      renameConversation: (id, title) => {
        const trimmed = title.replace(/\s+/g, ' ').trim()
        if (!trimmed) return
        const next = trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed
        set((s) => {
          const conv = s.conversations[id]
          if (!conv) return s
          return {
            conversations: {
              ...s.conversations,
              [id]: { ...conv, title: next, updatedAt: Date.now() },
            },
          }
        })
      },

      setView: (view) => set({ view }),

      saveCurrent: () => {
        const { activeId, conversations } = get()
        if (!activeId) return
        const conv = conversations[activeId]
        if (!conv) return
        const liveMessages = useChat.getState().messages
        // Drop error.stack before persisting. Stacks are only useful in the
        // live session and would balloon localStorage + leak internal paths
        // into stored state. The rest of the ChatError (message, name,
        // recovered, request) stays so reloaded conversations still show
        // the structured error block.
        const messages = liveMessages.map((m) =>
          m.error?.stack
            ? { ...m, error: { ...m.error, stack: undefined } }
            : m,
        )
        const title =
          conv.title === 'New chat'
            ? deriveTitle(messages) ?? conv.title
            : conv.title
        const updated: Conversation = {
          ...conv,
          messages,
          title,
          updatedAt: Date.now(),
        }
        set((s) => ({
          conversations: { ...s.conversations, [activeId]: updated },
          order: [activeId, ...s.order.filter((x) => x !== activeId)],
        }))
      },

      ensureActive: () => {
        const { activeId } = get()
        if (activeId) return activeId
        return get().newConversation()
      },

      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    {
      name: 'ubcllm-conversations',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // After hydration, load the active conversation's messages into the
      // chat store so the UI reflects what the user was last looking at.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const { activeId, conversations } = state
        if (activeId && conversations[activeId]) {
          useChat.setState({
            messages: conversations[activeId].messages,
            streaming: false,
          })
        }
      },
    },
  ),
)
