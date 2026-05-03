import { useEffect, useRef, useState } from 'react'
import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm'
import { topK } from '../lib/retrieve'
import { streamChat } from '../lib/llm'
import { SYSTEM_PROMPT, userPromptWithContext } from '../lib/prompts'
import { makeMessage, useChat, type Message } from '../store/chat'
import { useConversations } from '../store/conversations'
import { ChatMessage } from './ChatMessage'

const HISTORY_TURNS = 6 // last N (user, assistant) pairs sent to the LLM

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

  const [input, setInput] = useState('')
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

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
      const sources = await topK(q, 8)
      setSourcesOnLast(sources)

      const prior = useChat
        .getState()
        .messages.slice(0, -2) // drop the just-added user + empty assistant
      const recent = prior.slice(-HISTORY_TURNS * 2)

      const llmMessages: ChatCompletionMessageParam[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...toLLMHistory(recent),
        { role: 'user', content: userPromptWithContext(q, sources) },
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
    <div className="flex flex-col h-screen flex-1 p-4 gap-4">
      <header className="flex items-baseline justify-between border-b border-zinc-800 pb-2">
        <h1 className="text-lg font-semibold">Advisor</h1>
        <span className="text-xs text-zinc-500">
          UBC Vancouver · runs in your browser
        </span>
      </header>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto space-y-3 pr-1">
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

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
        className="flex gap-2"
      >
        <input
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
  )
}
