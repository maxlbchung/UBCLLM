import { useEffect, useRef, useState } from 'react'
import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm'
import {
  extractCourseCodes,
  getCourseIndex,
  topK,
  type Chunk,
} from '../lib/retrieve'
import { streamChat } from '../lib/llm'
import { SYSTEM_PROMPT, userPromptWithContext } from '../lib/prompts'
import { makeMessage, useChat, type Message } from '../store/chat'
import { useConversations } from '../store/conversations'
import { ChatMessage } from './ChatMessage'

const HISTORY_TURNS = 6 // last N (user, assistant) pairs sent to the LLM

// Bare subject codes ("DSCI", "CPSC", "MATH_V") embed close to their own
// course chunks (cosine 0.5–0.65), so the threshold floor can't filter
// them — they're "relevant" but the user hasn't actually asked anything.
// We detect them here, skip RAG entirely, and signal the model to ask a
// clarifying question via userPromptWithContext's bareSubject parameter.
const BARE_SUBJECT_RE = /^[A-Z]{3,5}(?:_V)?$/i

function toLLMHistory(history: Message[]): ChatCompletionMessageParam[] {
  return history
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }))
}

export function Chat() {
  const messages = useChat((s) => s.messages)
  const streaming = useChat((s) => s.streaming)
  const addMessage = useChat((s) => s.addMessage)
  const appendToLast = useChat((s) => s.appendToLast)
  const setSourcesOnLast = useChat((s) => s.setSourcesOnLast)
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

    try {
      const bareSubject = BARE_SUBJECT_RE.test(q)
        ? q.toUpperCase().replace(/_V$/, '')
        : undefined

      let sources: Chunk[] = []
      let missingCodes: string[] = []
      if (!bareSubject) {
        const [topKResult, courseIndex] = await Promise.all([
          topK(q, 8),
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

      const prior = useChat
        .getState()
        .messages.slice(0, -2) // drop the just-added user + empty assistant
      const recent = prior.slice(-HISTORY_TURNS * 2)

      const llmMessages: ChatCompletionMessageParam[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...toLLMHistory(recent),
        {
          role: 'user',
          content: userPromptWithContext(q, sources, missingCodes, bareSubject),
        },
      ]

      for await (const delta of streamChat(llmMessages)) {
        appendToLast(delta)
      }
    } catch (err) {
      console.error(err)
      appendToLast(`\n\n_Error: ${(err as Error).message}_`)
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
            onChange={(e) => setInput(e.target.value)}
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
      </div>
    </div>
  )
}
