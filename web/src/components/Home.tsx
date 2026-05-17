import { useConversations } from '../store/conversations'
import { useLLMLoader } from '../store/llmLoader'
import { modelLabel } from '../lib/llm'
import { playSfx } from '../lib/sfx'
import { CalendarWidget } from './CalendarWidget'

// Landing page. Replaces the pre-1.8 full-screen ModelLoader splash that
// blocked the app until weights were ready. The model auto-loads on
// startup (App.tsx fires useLLMLoader.startLoad('2b') unconditionally),
// so this page is purely informational — it sets context for a
// first-time visitor and provides the explicit "Start chatting" entry
// point.
export function Home() {
  const newConversation = useConversations((s) => s.newConversation)
  const setView = useConversations((s) => s.setView)
  const order = useConversations((s) => s.order)
  const setActive = useConversations((s) => s.setActive)
  const loadingFor = useLLMLoader((s) => s.loadingFor)
  const loadedFor = useLLMLoader((s) => s.loadedFor)
  const progress = useLLMLoader((s) => s.progress)
  const mode = useLLMLoader((s) => s.mode)
  const loadError = useLLMLoader((s) => s.error)

  const status: { tone: 'info' | 'progress' | 'ready' | 'error'; text: string } = (() => {
    if (loadingFor) {
      const text =
        mode === 'warming'
          ? `Warming up ${modelLabel(loadingFor)}…`
          : `Loading ${modelLabel(loadingFor)} model · ${Math.round(progress * 100)}%`
      return { tone: 'progress', text }
    }
    if (loadedFor) {
      return {
        tone: 'ready',
        text: `${modelLabel(loadedFor)} ready — ask away`,
      }
    }
    if (loadError) {
      return { tone: 'error', text: 'Model load failed — open the chat to retry.' }
    }
    return { tone: 'info', text: 'Initializing model…' }
  })()

  function startChat() {
    playSfx('click')
    // If the user already has a conversation, jump into the most
    // recent one rather than creating an empty fourth tab. The chat
    // panel still shows the picker if no model is selected, so this
    // route is safe whether the user has weights ready or not.
    if (order.length > 0) {
      setActive(order[0])
    } else {
      newConversation()
    }
  }

  function openTool(view: 'lookup' | 'prereq') {
    playSfx('tab')
    setView(view)
  }

  return (
    <div className="h-screen w-full min-h-0 overflow-y-auto">
     <div className="flex flex-col p-8 gap-8 max-w-6xl mx-auto w-full">
      <header className="flex flex-col items-center text-center gap-3 pt-8">
        <img
          src={`${import.meta.env.BASE_URL}logo.png`}
          alt="Reodite"
          className="h-20 w-20"
        />
        <h1 className="text-3xl font-semibold tracking-tight">Welcome to Reodite</h1>
        <p className="text-base text-fg-muted max-w-2xl leading-relaxed">
          AI powered academic advisor. Models are run locally, keeping your data safe.
        </p>
      </header>

      <div className="flex justify-center">
        <div
          className={
            'inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-xs font-mono ' +
            (status.tone === 'ready'
              ? 'border-line-soft bg-accent-soft text-accent-soft-fg'
              : status.tone === 'progress'
                ? 'border-line bg-surface-soft text-fg-muted'
                : status.tone === 'error'
                  ? 'border-danger-soft bg-danger-soft text-danger-fg'
                  : 'border-line bg-surface-soft text-fg-faint')
          }
        >
          <span
            aria-hidden
            className={
              'h-1.5 w-1.5 rounded-full ' +
              (status.tone === 'ready'
                ? 'bg-accent'
                : status.tone === 'progress'
                  ? 'bg-highlight animate-pulse'
                  : status.tone === 'error'
                    ? 'bg-danger'
                    : 'bg-fg-faint')
            }
          />
          {status.text}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button
          onClick={startChat}
          className="flex flex-col items-start gap-2 rounded-lg border border-line bg-surface-soft hover:bg-surface-raised hover:border-line-soft p-5 text-left transition-colors"
        >
          <span className="text-2xl" aria-hidden>💬</span>
          <span className="text-sm font-semibold">Start chatting</span>
          <span className="text-xs text-fg-muted leading-relaxed">
            Ask about UBC courses, programs, and prerequisites. Answers
            cite the calendar entries used.
          </span>
        </button>
        <button
          onClick={() => openTool('lookup')}
          className="flex flex-col items-start gap-2 rounded-lg border border-line bg-surface-soft hover:bg-surface-raised hover:border-line-soft p-5 text-left transition-colors"
        >
          <span className="text-2xl" aria-hidden>🔎</span>
          <span className="text-sm font-semibold">Course Lookup</span>
          <span className="text-xs text-fg-muted leading-relaxed">
            Type a course code (e.g. CPSC 110) for a structured detail
            card — credits, prereqs, description.
          </span>
        </button>
        <button
          onClick={() => openTool('prereq')}
          className="flex flex-col items-start gap-2 rounded-lg border border-line bg-surface-soft hover:bg-surface-raised hover:border-line-soft p-5 text-left transition-colors"
        >
          <span className="text-2xl" aria-hidden>🌳</span>
          <span className="text-sm font-semibold">Prerequisite Tree</span>
          <span className="text-xs text-fg-muted leading-relaxed">
            Visualize the full transitive prerequisite graph for any
            UBC course, with branch selectors on disjunctions.
          </span>
        </button>
      </div>

      <CalendarWidget />
     </div>
    </div>
  )
}
