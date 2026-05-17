import { useEffect, useRef, useState } from 'react'
import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm'
import {
  extractCourseCodes,
  getCourseIndex,
  topK,
  type Chunk,
} from '../lib/retrieve'
import { getDiagSnapshot, modelLabel, streamChat } from '../lib/llm'
import { playSfx, startBotThinking, stopBotThinking } from '../lib/sfx'
import { useSettings, type ModelSize } from '../store/settings'
import { useLLMLoader } from '../store/llmLoader'
import {
  buildSystemPrompt,
  userPromptWithContext,
  type SystemPromptMode,
} from '../lib/prompts'
import {
  makeMessage,
  useChat,
  type ChatError,
} from '../store/chat'
import { useConversations } from '../store/conversations'
import { useEasterEggs } from '../store/easterEggs'
import { ChatMessage } from './ChatMessage'

// Bare subject codes ("DSCI", "CPSC", "MATH_V") embed close to their own
// course chunks (cosine 0.5–0.65), so the threshold floor can't filter
// them — they're "relevant" but the user hasn't actually asked anything.
// We detect them here, skip RAG entirely, and signal the model to ask a
// clarifying question via userPromptWithContext's bareSubject parameter.
//
// Real UBC subject codes are 2–4 letters (2: AI/BA, 3: e.g. CSE/EDP,
// 4: e.g. CPSC/MATH). The shape regex is a cheap pre-filter; the caller
// cross-checks the candidate against the real UBC subject set
// (getSubjectSet) before flipping into bareSubject mode, so non-subject
// inputs (greetings like "hello", typos, unrelated words) fall through
// to the standard retrieval path and land in noSources mode.
const BARE_SUBJECT_RE = /^[A-Z]{2,4}(?:_V)?$/i

// Hard cap on composer input. Real questions are well under this; the cap
// keeps the prefill bounded and prevents pathological pastes from blowing
// past MiniLM's ~512-token window or eating the LLM's context budget.
const MAX_INPUT_LENGTH = 500

// Wallclock backstop on a single generation. If the model is still
// streaming after this long we abort the controller so the GPU loop
// releases and the user gets the input back without having to click
// Stop manually. Distinct from the per-token inactivity timeout in
// llm.ts (that one catches silent stalls; this one caps total reply
// length even if the model is producing fluent but excessively long
// output). 5 minutes is generous on purpose so the 9B tier on
// integrated GPUs has room for cold prefill (60–120s) plus a long
// answer (~30s of token streaming) without auto-cancelling.
const TOTAL_STREAM_TIMEOUT_MS = 300_000

export function Chat() {
  const messages = useChat((s) => s.messages)
  const streaming = useChat((s) => s.streaming)
  const addMessage = useChat((s) => s.addMessage)
  const appendToLast = useChat((s) => s.appendToLast)
  const setSourcesOnLast = useChat((s) => s.setSourcesOnLast)
  const setErrorOnLast = useChat((s) => s.setErrorOnLast)
  const setStopReasonOnLast = useChat((s) => s.setStopReasonOnLast)
  const setStreaming = useChat((s) => s.setStreaming)
  const view = useConversations((s) => s.view)

  // Model lifecycle. The app auto-loads Qwen3.5 2B on startup
  // (App.tsx → useLLMLoader.startLoad('2b')), so there's no picker.
  // The composer's send is gated on `loadedFor !== null` (the engine
  // is alive and ready) so pre-load submits can't fire.
  const loadingFor = useLLMLoader((s) => s.loadingFor)
  const loadedFor = useLLMLoader((s) => s.loadedFor)
  const loadProgress = useLLMLoader((s) => s.progress)
  const loadMode = useLLMLoader((s) => s.mode)
  const loadError = useLLMLoader((s) => s.error)
  const retry = useLLMLoader((s) => s.retry)
  const clearCacheAndRetry = useLLMLoader((s) => s.clearCacheAndRetry)

  const [input, setInput] = useState('')
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // AbortController for the in-flight stream. Populated when send()
  // starts, fired by the Stop button or the wallclock watchdog below,
  // cleared in the finally block. Held in a ref so the Stop click
  // handler always sees the current controller without re-rendering.
  const abortControllerRef = useRef<AbortController | null>(null)
  // Tracks which path triggered the most recent abort. streamChat's
  // AbortSignal doesn't carry a reason field we can read back, so we
  // record it here at the call site instead. Used after the stream
  // returns to label the assistant message ('user' from the Stop
  // button, 'timeout' from the wallclock watchdog). Engine-death
  // aborts leave the ref null and route the cause through the message
  // bubble's ErrorDetails block instead — no italic note in that case
  // since ErrorDetails already explains what happened.
  const abortReasonRef = useRef<'user' | 'timeout' | null>(null)

  useEffect(() => {
    // Scrolls on every message delta. setErrorOnLast also bumps the
    // messages reference (chat store does an immutable spread) so a
    // mid-stream load-failure setting the error on the active bubble
    // re-triggers the scroll naturally — no separate loadError dep.
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // If the model engine dies while a turn is in flight (GPUDevice lost,
  // worker crash, stale-engine fallback giving up) the discard listener
  // in llmLoader.ts flips loadedFor → null and surfaces an error. We
  // (a) push that error onto the active assistant message so the
  // existing in-bubble ErrorDetails block renders the cause, and
  // (b) abort the in-flight stream so the assistant turn resolves
  // immediately instead of sitting on thinking dots until the 180s
  // inactivity timeout fires. No stop-note is appended here — the
  // ErrorDetails block is the user-facing signal; the italic note
  // path is reserved for clean stops without an error.
  useEffect(() => {
    if (loadError && streaming && abortControllerRef.current) {
      setErrorOnLast(loadError)
      abortControllerRef.current.abort()
    }
  }, [loadError, streaming, setErrorOnLast])

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

  function cancelStream() {
    const controller = abortControllerRef.current
    if (!controller) return
    playSfx('click')
    abortReasonRef.current = 'user'
    controller.abort()
    // The streamChat generator's abort handler calls
    // engine.interruptGenerate() and the abort-race in the iter loop
    // returns { aborted: true } so the UI reverts to Send immediately.
    // resetChat() on the next send clears any KV state left behind.
  }

  async function send() {
    const q = input.trim()
    if (!q || streaming) return
    // Belt-and-suspenders: the input + Send button are both disabled
    // when loadedFor is null, but guard here too so a programmatic
    // submit can't reach streamChat before the engine exists.
    if (!loadedFor) return
    setInput('')
    playSfx('send')

    useConversations.getState().ensureActive()

    addMessage(makeMessage('user', q))
    addMessage(makeMessage('assistant', ''))
    setStreaming(true)
    useConversations.getState().saveCurrent()

    // Bot-noise lifecycle: a low pulse plays while we wait for the first
    // streamed token ("thinking"), then switches to per-token typing
    // ticks once the stream starts. Gate read once at the top of the
    // turn so a mid-stream settings flip doesn't half-engage / half-
    // disengage the audio — the user-experienced "this turn" stays
    // consistent.
    const botSfxOn = useSettings.getState().botNoisesEnabled
    if (botSfxOn) startBotThinking()

    // Hoisted so the catch block can attach a request snapshot to the
    // ChatError. They start empty/undefined and get filled inside the try.
    let sources: Chunk[] = []
    let llmMessages: ChatCompletionMessageParam[] = []

    // One AbortController per send. Fired by the Stop button (via
    // cancelStream above) or by the wallclock watchdog timer below.
    // streamChat respects the signal: on abort it calls
    // engine.interruptGenerate() and returns cleanly, so we don't have
    // to special-case aborted streams in the catch block.
    const controller = new AbortController()
    abortControllerRef.current = controller
    abortReasonRef.current = null
    const totalTimeoutId = window.setTimeout(() => {
      // Wallclock fired: classify as 'timeout' so the resulting stop
      // banner reads "took too long" rather than "stopped by user".
      // Set the ref *before* abort() so the abort handler/return path
      // sees the correct cause.
      abortReasonRef.current = 'timeout'
      controller.abort()
    }, TOTAL_STREAM_TIMEOUT_MS)

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

      // Mode-aware system prompt: the citation/refusal/anti-echo rules live
      // there (not at the user-message tail) so the chat template's
      // <|im_start|>system fence marks them as policy. Mode is decided by
      // the retrieval outcome:
      //   - bareSubject → user typed just "DSCI"; user-message Note drives
      //     behavior, so we drop the rules to avoid contradicting it.
      //   - easter → retrieval collapsed to a single curated chunk; use the
      //     strict-quote variant so the model doesn't refuse the absurd-
      //     sounding answer.
      //   - default → standard RAG path.
      // Each turn is single-shot — no prior user queries or assistant
      // replies are sent. Multi-turn history was producing fact-bleed
      // (model carried a course code from a prior reply into the next
      // answer); reverting to stateless calls makes each answer derive
      // strictly from the current turn's RAG sources.
      const easterMode = sources.length === 1 && sources[0].kind === 'easter'
      const mode: SystemPromptMode = bareSubject
        ? 'bareSubject'
        : easterMode
          ? 'easter'
          : sources.length === 0
            ? 'noSources'
            : 'default'

      llmMessages = [
        { role: 'system', content: buildSystemPrompt(mode) },
        {
          role: 'user',
          content: userPromptWithContext(q, sources, missingCodes, bareSubject),
        },
      ]

      // Manual .next() loop instead of for-await so we can read the
      // generator's return value (the recovery flag from streamChat).
      // Pass `size: loadedFor` so streamChat's rebuild path can fire
      // even when module-level activeSize was nulled out by a silent
      // device-lost between load completion and this send — without
      // the hint, streamChat would otherwise throw "No model is
      // loaded" despite the UI showing the engine as ready.
      const it = streamChat(llmMessages, {
        signal: controller.signal,
        size: loadedFor ?? undefined,
      })
      let result = await it.next()
      let firstToken = true
      while (!result.done) {
        if (botSfxOn) {
          if (firstToken) {
            // Hand off from the thinking pulse to typing ticks the moment
            // a real token appears, so the two never overlap.
            stopBotThinking()
            firstToken = false
          }
          // Throttle to ~100 ms so a fast token stream doesn't produce a
          // continuous buzz; the result reads as a steady "typing" rhythm
          // rather than a literal tick-per-token.
          playSfx('botTyping', 100)
        }
        appendToLast(result.value)
        result = await it.next()
      }
      // result.value carries `{ recovered, aborted?, wordCapped? }`.
      // Classify clean-stops (user / wallclock / length) so the user
      // sees an explicit italic note instead of a silently truncated
      // reply. Error-driven aborts (the mid-stream load-failure effect
      // above) leave abortReasonRef null — those land on the message
      // via setErrorOnLast and render through ErrorDetails, not via
      // the stopReason note.
      const ret = result.value
      if (ret?.aborted && abortReasonRef.current) {
        setStopReasonOnLast(abortReasonRef.current)
      } else if (ret?.wordCapped) {
        setStopReasonOnLast('word_cap')
      }
      stopBotThinking()
    } catch (err) {
      stopBotThinking()
      playSfx('error')
      const requestSnapshot = {
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
      // No stopReason on the catch path — the chatError below carries
      // the cause via name + message, and ChatMessage's ErrorDetails
      // renders it inline. Setting a stopReason here would duplicate
      // that signal with an italic note.
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
      // Belt-and-suspenders: both the success and catch branches already
      // call stopBotThinking, but if a throw bubbles up before either is
      // reached the timer would otherwise leak. stopBotThinking is a
      // no-op when the timer isn't running, so this is always safe.
      stopBotThinking()
      window.clearTimeout(totalTimeoutId)
      // Drop the controller ref only if it's still ours — a fresh send
      // (after the user cancelled and immediately sent again) would have
      // already replaced it, and we don't want to null out the new one.
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
      }
      setStreaming(false)
      useConversations.getState().saveCurrent()
    }
  }

  // Composer enabled when (a) not streaming, (b) the engine has
  // finished loading. `loadedFor !== null` is the canonical "engine is
  // alive" signal. The text input now stays editable during streaming
  // so users can prepare their next message — the Stop/Send button
  // toggle is what gates actually submitting.
  const composerEnabled = !!loadedFor && !streaming
  const inputEnabled = !!loadedFor
  // Inline error card appears on a brand-new chat when the background
  // load failed (no engine, no load in flight, error set). It shows
  // why and offers retry / clear-cache. Once a conversation has any
  // messages, the in-bubble ErrorDetails path handles mid-stream
  // failures instead so the user's history isn't trampled.
  const showLoadErrorCard =
    messages.length === 0 && !loadedFor && !loadingFor && !!loadError

  return (
    // The scroller is full-width on purpose so the cursor over the side
    // gutters still scrolls the chat. We center each row's content via an
    // inner `mx-auto max-w-[1200px]` wrapper instead of constraining the
    // scroller itself.
    <div className="flex flex-col h-screen flex-1 py-4 min-h-0 gap-4">
      <div className="mx-auto w-full max-w-[1200px] px-4">
        <header className="flex items-baseline justify-between border-b border-line pb-2">
          <h1 className="text-lg font-semibold">AI Chatbot</h1>
          <span className="text-xs text-fg-faint">
            Reodite can make mistakes · Make sure to verify important information
          </span>
        </header>
      </div>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto min-h-0">
        <div className="mx-auto w-full max-w-[1200px] px-4 space-y-3">
          {showLoadErrorCard ? (
            <LoadErrorCard
              loadError={loadError!}
              onRetry={() => {
                playSfx('click')
                void retry()
              }}
              onClearCache={() => {
                playSfx('click')
                void clearCacheAndRetry()
              }}
            />
          ) : (
            messages.length === 0 && (
              <div className="text-center text-fg-faint mt-12 text-sm">
                Ask about a UBC Vancouver course or program. Try:
                <ul className="mt-2 space-y-1">
                  <li>"What are the prerequisites for CPSC 110?"</li>
                  <li>"How many credits is MATH 200?"</li>
                  <li>"Which courses count as Arts electives?"</li>
                </ul>
              </div>
            )
          )}
          {messages.map((m) => (
            <ChatMessage key={m.id} message={m} />
          ))}
        </div>
      </div>

      <div className="mx-auto w-full max-w-[1200px] px-4 flex flex-col gap-2">
        {/* Progress banner — only renders while a load is in flight.
            Load failures render as an inline bubble in the message
            scroller above (LoadErrorMessage), not as a persistent
            banner here. */}
        {loadingFor && (
          <LoadBanner
            size={loadingFor}
            progress={loadProgress}
            mode={loadMode}
          />
        )}
        {/* Compact retry banner — only renders when a load failed and
            the chat already has messages (so the inline LoadErrorCard
            in the scroller can't surface). Keeps a recovery path
            visible without forcing the user to reload the page. */}
        {loadError && !loadingFor && messages.length > 0 && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-danger-soft bg-danger-soft/40 px-4 py-2 text-xs">
            <span className="text-danger-fg">
              Model load failed: {loadError.message}
            </span>
            <div className="flex gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  playSfx('click')
                  void retry()
                }}
                className="px-2 py-1 rounded bg-surface-soft hover:bg-line-soft text-fg border border-line-soft"
              >
                Try again
              </button>
              {/cache|network|fetch/i.test(loadError.message) && (
                <button
                  type="button"
                  onClick={() => {
                    playSfx('click')
                    void clearCacheAndRetry()
                  }}
                  className="px-2 py-1 rounded bg-surface-soft hover:bg-line-soft text-fg border border-line-soft"
                >
                  Clear cache
                </button>
              )}
            </div>
          </div>
        )}
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
            disabled={!inputEnabled}
            className="flex-1 rounded bg-input border border-line-soft text-fg px-3 py-2 text-sm focus:outline-none focus:border-fg-faint disabled:opacity-60"
            placeholder={
              loadingFor
                ? `Loading ${modelLabel(loadingFor)}…`
                : loadError
                  ? 'Model unavailable — try again above'
                  : !loadedFor
                    ? 'Model not ready'
                    : streaming
                      ? 'Generating…'
                      : 'Ask about a UBC course or program'
            }
          />
          {streaming ? (
            <button
              type="button"
              onClick={cancelStream}
              className="rounded bg-danger-soft hover:bg-danger-soft/80 text-danger-fg px-4 py-2 text-sm font-medium"
              title="Cancel the in-progress response"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!composerEnabled || !input.trim()}
              className="rounded bg-accent hover:bg-accent-hover text-accent-fg disabled:opacity-50 disabled:hover:bg-accent px-4 py-2 text-sm font-medium"
            >
              Send
            </button>
          )}
        </form>
        {input.length >= MAX_INPUT_LENGTH * 0.8 && (
          <div
            className={`mt-1 text-right text-xs ${input.length >= MAX_INPUT_LENGTH
              ? 'text-highlight'
              : 'text-fg-faint'
              }`}
          >
            {input.length} / {MAX_INPUT_LENGTH}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Load error card ─────────────────────────────────────────────────
//
// Shown center-stage on a brand-new chat when the auto-load failed.
// There's no picker any more (we hardcoded Qwen3.5 2B), so this card
// surfaces the error inline and gives the user retry / clear-cache
// affordances. Once the conversation has any messages, mid-stream
// failures route through the in-bubble ErrorDetails block instead so
// the chat history isn't trampled.

function LoadErrorCard({
  loadError,
  onRetry,
  onClearCache,
}: {
  loadError: ChatError
  onRetry: () => void
  onClearCache: () => void
}) {
  const isNetworkError = /cache|network|fetch/i.test(loadError.message)
  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center">
      <h2 className="text-2xl font-semibold">Model load failed</h2>
      <p className="text-sm text-fg-muted max-w-xl">{loadError.message}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1.5 rounded bg-accent hover:bg-accent-hover text-accent-fg text-xs font-medium"
        >
          Try again
        </button>
        {isNetworkError && (
          <button
            type="button"
            onClick={onClearCache}
            className="px-3 py-1.5 rounded bg-surface-soft hover:bg-line-soft text-fg text-xs font-medium border border-line-soft"
          >
            Clear cache and retry
          </button>
        )}
      </div>
    </div>
  )
}

// ── Load banner ─────────────────────────────────────────────────────

function LoadBanner({
  size,
  progress,
  mode,
}: {
  size: ModelSize
  progress: number
  mode: 'unknown' | 'cold' | 'warm' | 'warming'
}) {
  const heading =
    mode === 'warming'
      ? `Warming up ${modelLabel(size)}`
      : mode === 'warm'
        ? `Loading ${modelLabel(size)} from cache`
        : `Loading ${modelLabel(size)}`
  const caption =
    mode === 'warming'
      ? 'Compiling GPU shaders so your first message is fast.'
      : mode === 'warm'
        ? 'Reusing weights cached in your browser from a previous visit.'
        : "First load downloads the model. It's cached for next visit."
  // While warming, the progress bar would just sit at 100% with no
  // meaningful update — render an indeterminate animated bar instead
  // so the user can tell something is still happening.
  const indeterminate = mode === 'warming'
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-soft px-4 py-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-fg">{heading}</span>
        {!indeterminate && (
          <span className="font-mono text-fg-faint tabular-nums">
            {Math.round(progress * 100)}%
          </span>
        )}
      </div>
      <div className="w-full h-1.5 bg-surface-raised rounded-full overflow-hidden">
        {indeterminate ? (
          <div className="h-full w-full bg-accent rounded-full animate-pulse" />
        ) : (
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        )}
      </div>
      <p className="text-[0.6875rem] text-fg-faint">{caption}</p>
    </div>
  )
}

