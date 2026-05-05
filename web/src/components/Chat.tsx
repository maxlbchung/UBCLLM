import { useEffect, useRef, useState } from 'react'
import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm'
import {
  extractCourseCodes,
  getCourseIndex,
  topK,
  type Chunk,
} from '../lib/retrieve'
import { getDiagSnapshot, streamChat } from '../lib/llm'
import { buildSystemPrompt, userPromptWithContext } from '../lib/prompts'
import {
  makeMessage,
  useChat,
  type ChatError,
  type Message,
} from '../store/chat'
import { useConversations } from '../store/conversations'
import { useEasterEggs } from '../store/easterEggs'
import { ChatMessage } from './ChatMessage'

// Last N (user, assistant) pairs sent to the LLM each turn. Each pair is
// roughly 1 kB of text on average for an advisor reply, so 3 turns adds
// ~6 kB to the prefill on top of the system prompt + RAG context. 6 used
// to be the cap and was making long conversations TDR — bigger prefill =
// more likely to exceed Windows' ~2s GPU compute limit. 3 covers
// Q-A-Q-A-Q-A clarification chains, which is plenty for follow-ups like
// "what about its prereqs?" while keeping the worst-case prompt bounded.
const HISTORY_TURNS = 3

// Bare subject codes ("DSCI", "CPSC", "MATH_V") embed close to their own
// course chunks (cosine 0.5–0.65), so the threshold floor can't filter
// them — they're "relevant" but the user hasn't actually asked anything.
// We detect them here, skip RAG entirely, and signal the model to ask a
// clarifying question via userPromptWithContext's bareSubject parameter.
const BARE_SUBJECT_RE = /^[A-Z]{3,5}(?:_V)?$/i

// Hard cap on composer input. Real questions are well under this; the cap
// keeps the prefill bounded and prevents pathological pastes from blowing
// past MiniLM's ~512-token window or eating the LLM's context budget.
const MAX_INPUT_LENGTH = 500

// Earlier user queries fed back to the model as a "reference only" preamble
// (see prompts.ts → formatPriorQueries). We deliberately drop past assistant
// replies — they were the source of the fact-bleed bug where the model would
// carry a course code from a prior answer into the next reply, even when the
// new sources said something different. Keeping just the user's prior queries
// lets the model still resolve "what about its prereqs?" / "tell me more"
// follow-ups without re-introducing that bleed.
function priorUserQueries(history: Message[]): string[] {
  return history
    .filter((m) => m.role === 'user')
    .map((m) => m.content.trim())
    .filter((q) => q.length > 0)
}

export function Chat() {
  const messages = useChat((s) => s.messages)
  const streaming = useChat((s) => s.streaming)
  const addMessage = useChat((s) => s.addMessage)
  const appendToLast = useChat((s) => s.appendToLast)
  const setSourcesOnLast = useChat((s) => s.setSourcesOnLast)
  const setErrorOnLast = useChat((s) => s.setErrorOnLast)
  const setStreaming = useChat((s) => s.setStreaming)
  const view = useConversations((s) => s.view)

  const [input, setInput] = useState('')
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // Auto-focus the composer so the user never has to click into it: on first
  // mount (streaming starts false → fires once), each time streaming flips
  // back to false (input becomes enabled again after a reply), and whenever
  // the user navigates back to the chat view from a tool. The Shell keeps
  // all panels mounted via `display: none`, so a useEffect on `view` is the
  // only way to retrigger focus on view-switch — and `display: none` makes
  // the intermediate focus calls no-ops, so there's no risk of stealing
  // focus from CourseLookup / PrereqTree while they're active.
  useEffect(() => {
    if (!streaming && view === 'chat') inputRef.current?.focus()
  }, [streaming, view])

  async function send() {
    const q = input.trim()
    if (!q || streaming) return
    setInput('')

    useConversations.getState().ensureActive()

    addMessage(makeMessage('user', q))
    addMessage(makeMessage('assistant', ''))
    setStreaming(true)
    useConversations.getState().saveCurrent()

    // Hoisted so the catch block can attach a request snapshot to the
    // ChatError. They start empty/undefined and get filled inside the try.
    let sources: Chunk[] = []
    let recent: Message[] = []
    let llmMessages: ChatCompletionMessageParam[] = []

    try {
      const bareSubject = BARE_SUBJECT_RE.test(q)
        ? q.toUpperCase().replace(/_V$/, '')
        : undefined

      let missingCodes: string[] = []
      if (!bareSubject) {
        const [topKResult, courseIndex] = await Promise.all([
          topK(q),
          getCourseIndex(),
        ])
        sources = topKResult
        // Course codes the user mentioned but which aren't in the calendar.
        // Surface as a hard signal so the model takes the refusal path
        // instead of confabulating from neighbouring CPSC chunks.
        missingCodes = extractCourseCodes(q).filter(
          (code) => !courseIndex.has(code),
        )
      }
      setSourcesOnLast(sources)

      // Easter-egg discovery: topK collapses to a single chunk when an
      // easter wins the top slot (see retrieve.ts → easterCollapse), so a
      // top-source kind === 'easter' is the canonical "egg triggered" signal.
      const top = sources[0]
      if (top?.kind === 'easter') {
        useEasterEggs.getState().markDiscovered(top.id)
      }

      const prior = useChat
        .getState()
        .messages.slice(0, -2) // drop the just-added user + empty assistant
      recent = prior.slice(-HISTORY_TURNS * 2)
      const earlierQueries = priorUserQueries(recent)

      // No more alternating user/assistant turns sent to the LLM — earlier
      // queries are bundled into the current user message via prompts.ts so
      // the model sees them as reference-only context, not as authoritative
      // prior answers.
      llmMessages = [
        { role: 'system', content: buildSystemPrompt(sources, bareSubject) },
        {
          role: 'user',
          content: userPromptWithContext(
            q,
            sources,
            missingCodes,
            bareSubject,
            earlierQueries,
          ),
        },
      ]

      // Manual .next() loop instead of for-await so we can read the
      // generator's return value (the recovery flag from streamChat).
      const it = streamChat(llmMessages)
      let result = await it.next()
      while (!result.done) {
        appendToLast(result.value)
        result = await it.next()
      }
      // result.value is { recovered }; we don't surface a UI hint when
      // recovery happened transparently, only when an error is thrown.
    } catch (err) {
      const requestSnapshot = {
        historyTurns: Math.floor(recent.length / 2),
        sourceCount: sources.length,
        query: q,
      }
      const isErrInstance = err instanceof Error
      // String rejections sneak in from the WebLLM worker proxy
      // (see web_worker.d.ts → proxy reject(msg.content)). Normalize to
      // a structured ChatError instead of stringifying with .message,
      // which would yield 'undefined' for those.
      const chatError: ChatError = {
        message: isErrInstance ? err.message : String(err),
        name: isErrInstance ? err.name : undefined,
        stack: isErrInstance ? err.stack : undefined,
        recovered: Boolean((err as { recovered?: boolean })?.recovered),
        request: requestSnapshot,
        // Snapshot of recent diag events (visibility, engine lifecycle,
        // worker device.lost firings) — lets the user copy the timeline
        // leading up to the error without having to reproduce with
        // DevTools open.
        diag: getDiagSnapshot(),
      }
      // console.error of a string shows no expand arrow. Group the raw
      // error, type-introspection facts, and the structured copy so any
      // shape (Error, string, plain object) is inspectable in devtools.
      console.group('chat error')
      console.error('raw:', err)
      console.error('typeof:', typeof err)
      console.error('instanceof Error:', isErrInstance)
      console.error('String(err):', String(err))
      console.error('chatError:', chatError)
      console.error('llmMessages:', llmMessages)
      console.groupEnd()
      setErrorOnLast(chatError)
    } finally {
      setStreaming(false)
      useConversations.getState().saveCurrent()
    }
  }

  return (
    // The scroller is full-width on purpose so the cursor over the side
    // gutters still scrolls the chat. We center each row's content via an
    // inner `mx-auto max-w-[1200px]` wrapper instead of constraining the
    // scroller itself.
    <div className="flex flex-col h-screen flex-1 py-4 min-h-0 gap-4">
      <div className="mx-auto w-full max-w-[1200px] px-4">
        <header className="flex items-baseline justify-between border-b border-zinc-800 pb-2">
          <h1 className="text-lg font-semibold">Advisor</h1>
          <span className="text-xs text-zinc-500">
            UBC Vancouver · runs in your browser
          </span>
        </header>
      </div>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto min-h-0">
        <div className="mx-auto w-full max-w-[1200px] px-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-center text-zinc-500 mt-12 text-sm">
              Ask about a UBC Vancouver course or program. Try:
              <ul className="mt-2 space-y-1">
                <li>"What are the prerequisites for CPSC 110?"</li>
                <li>"How many credits is MATH 200?"</li>
                <li>"Which courses count as Arts electives?"</li>
              </ul>
            </div>
          )}
          {messages.map((m) => (
            <ChatMessage key={m.id} message={m} />
          ))}
        </div>
      </div>

      <div className="mx-auto w-full max-w-[1200px] px-4">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
          className="flex gap-2"
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) =>
              setInput(e.target.value.slice(0, MAX_INPUT_LENGTH))
            }
            maxLength={MAX_INPUT_LENGTH}
            disabled={streaming}
            className="flex-1 rounded bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm focus:outline-none focus:border-zinc-500 disabled:opacity-60"
            placeholder={
              streaming ? 'Generating…' : 'Ask about a UBC course or program'
            }
          />
          <button
            type="submit"
            disabled={streaming || !input.trim()}
            className="rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 px-4 py-2 text-sm font-medium"
          >
            Send
          </button>
        </form>
        {input.length >= MAX_INPUT_LENGTH * 0.8 && (
          <div
            className={`mt-1 text-right text-xs ${
              input.length >= MAX_INPUT_LENGTH
                ? 'text-amber-400'
                : 'text-zinc-500'
            }`}
          >
            {input.length} / {MAX_INPUT_LENGTH}
          </div>
        )}
      </div>
    </div>
  )
}
