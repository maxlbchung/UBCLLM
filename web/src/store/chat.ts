import { create } from 'zustand'
import type { Chunk } from '../lib/retrieve'

export type Role = 'user' | 'assistant'

/**
 * Structured error attached to an assistant message when streamChat throws.
 * Lives alongside `content` (which keeps any partial streamed tokens) so the
 * UI can render the failure as a separate block instead of a `_Error: ...`
 * blob inside the markdown.
 *
 * `recovered` means streamChat ran its discard-engine path — either it
 * transparently retried and succeeded (in which case there's no error to
 * surface, so this is mainly the mid-stream case) or the worker has been
 * torn down and the next user send will spawn a fresh one.
 */
export interface ChatError {
  message: string
  name?: string
  stack?: string
  recovered?: boolean
  request?: {
    historyTurns: number
    sourceCount: number
    query: string
  }
}

export interface Message {
  id: string
  role: Role
  content: string
  sources?: Chunk[]
  error?: ChatError
}

interface ChatState {
  messages: Message[]
  streaming: boolean
  addMessage: (m: Message) => void
  appendToLast: (delta: string) => void
  setSourcesOnLast: (sources: Chunk[]) => void
  setErrorOnLast: (error: ChatError) => void
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
  setErrorOnLast: (error) =>
    set((s) => {
      if (s.messages.length === 0) return {}
      const last = s.messages[s.messages.length - 1]
      // Errors only make sense on assistant turns. If somehow the last
      // message is the user's, log to console and skip — we'd corrupt the
      // chat shape otherwise.
      if (last.role !== 'assistant') {
        console.error('setErrorOnLast called when last message is not assistant', {
          lastRole: last.role,
          error,
        })
        return {}
      }
      const msgs = s.messages.slice()
      msgs[msgs.length - 1] = { ...last, error }
      return { messages: msgs }
    }),
  setStreaming: (v) => set({ streaming: v }),
  reset: () => set({ messages: [], streaming: false }),
}))
