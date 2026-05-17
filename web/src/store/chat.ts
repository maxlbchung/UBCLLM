import { create } from 'zustand'
import type { Chunk } from '../lib/retrieve'
import type { DiagEvent } from '../lib/llm'

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
 *
 * `diag` is the recent diagnostic timeline (visibility transitions, engine
 * lifecycle, device.lost firings, etc.) snapshotted at the moment the
 * error fired. Lets us tell whether the error correlates with a tab idle,
 * a device-lost event, or something else — without needing the user to
 * reproduce while DevTools is open.
 */
export interface ChatError {
  message: string
  name?: string
  stack?: string
  recovered?: boolean
  request?: {
    sourceCount: number
    query: string
  }
  diag?: DiagEvent[]
}

// Why the assistant stream stopped, when the cause was something other
// than a model-side EOS. ChatMessage reads this off the Message to
// render an inline banner. `undefined` on the message means the model
// ended its own reply normally; no banner needed.
//
//   'user'     — Stop button (cancelStream in Chat.tsx)
//   'timeout'  — wallclock watchdog or inactivity stall caught and
//                surfaced from streamChat's catch
//   'word_cap' — HARD_WORD_CAP backstop tripped on a runaway loop
//   'error'    — generic uncategorized failure; ChatMessage pairs this
//                with the structured ChatError block below it
export type StopReason = 'user' | 'timeout' | 'word_cap' | 'error'

export interface Message {
  id: string
  role: Role
  content: string
  sources?: Chunk[]
  error?: ChatError
  stopReason?: StopReason
}

interface ChatState {
  messages: Message[]
  streaming: boolean
  addMessage: (m: Message) => void
  appendToLast: (delta: string) => void
  setSourcesOnLast: (sources: Chunk[]) => void
  setErrorOnLast: (error: ChatError) => void
  setStopReasonOnLast: (reason: StopReason) => void
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
  setStopReasonOnLast: (reason) =>
    set((s) => {
      if (s.messages.length === 0) return {}
      const last = s.messages[s.messages.length - 1]
      if (last.role !== 'assistant') return {}
      const msgs = s.messages.slice()
      msgs[msgs.length - 1] = { ...last, stopReason: reason }
      return { messages: msgs }
    }),
  setStreaming: (v) => set({ streaming: v }),
  reset: () => set({ messages: [], streaming: false }),
}))
