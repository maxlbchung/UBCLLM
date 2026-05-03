import { create } from 'zustand'
import type { Chunk } from '../lib/retrieve'

export type Role = 'user' | 'assistant'

export interface Message {
  id: string
  role: Role
  content: string
  sources?: Chunk[]
}

interface ChatState {
  messages: Message[]
  streaming: boolean
  addMessage: (m: Message) => void
  appendToLast: (delta: string) => void
  setSourcesOnLast: (sources: Chunk[]) => void
  setStreaming: (v: boolean) => void
  reset: () => void
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2)
}

export function makeMessage(role: Role, content = ''): Message {
  return { id: newId(), role, content }
}

export const useChat = create<ChatState>((set) => ({
  messages: [],
  streaming: false,
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  appendToLast: (delta) =>
    set((s) => {
      if (s.messages.length === 0) return {}
      const msgs = s.messages.slice()
      const last = msgs[msgs.length - 1]
      msgs[msgs.length - 1] = { ...last, content: last.content + delta }
      return { messages: msgs }
    }),
  setSourcesOnLast: (sources) =>
    set((s) => {
      if (s.messages.length === 0) return {}
      const msgs = s.messages.slice()
      const last = msgs[msgs.length - 1]
      msgs[msgs.length - 1] = { ...last, sources }
      return { messages: msgs }
    }),
  setStreaming: (v) => set({ streaming: v }),
  reset: () => set({ messages: [], streaming: false }),
}))
