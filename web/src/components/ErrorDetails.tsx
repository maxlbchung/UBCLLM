import { useState } from 'react'
import type { ChatError } from '../store/chat'

const STACK_LINE_LIMIT = 40

function truncateStack(stack: string): string {
  const lines = stack.split('\n')
  if (lines.length <= STACK_LINE_LIMIT) return stack
  const dropped = lines.length - STACK_LINE_LIMIT
  return [
    ...lines.slice(0, STACK_LINE_LIMIT),
    `… (${dropped} more frame${dropped === 1 ? '' : 's'} omitted)`,
  ].join('\n')
}

/**
 * Inline error block. Used both in chat bubbles (under the assistant
 * message) and on the full-screen ModelLoader error state. Renders a
 * red-tinted headline that's always visible, plus a closed-by-default
 * disclosure for the stack and request snapshot, plus a copy-to-clipboard
 * button so failures are trivial to paste into a bug report.
 */
export function ErrorDetails({ error }: { error: ChatError }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(error, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      console.error('clipboard write failed', e)
    }
  }

  const headline =
    error.name && error.name !== 'Error'
      ? `${error.name}: ${error.message}`
      : error.message

  return (
    <div className="mt-2 rounded-md border border-red-900/60 bg-red-950/20 px-3 py-2 text-xs text-red-200">
      <div className="font-medium break-words">{headline}</div>
      {error.recovered && (
        <p className="mt-1 text-red-300/80">
          Engine was rebuilt — your next message should work.
        </p>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer select-none text-red-300/80 hover:text-red-200">
          Debug details
        </summary>

        {error.request && (
          <div className="mt-2">
            <p className="text-[0.625rem] uppercase tracking-wider text-red-300/60">
              Request
            </p>
            <ul className="mt-1 space-y-0.5 font-mono text-[0.6875rem] text-red-200/90">
              <li>query: {JSON.stringify(error.request.query)}</li>
              <li>historyTurns: {error.request.historyTurns}</li>
              <li>sourceCount: {error.request.sourceCount}</li>
            </ul>
          </div>
        )}

        {error.stack && (
          <div className="mt-2">
            <p className="text-[0.625rem] uppercase tracking-wider text-red-300/60">
              Stack
            </p>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[0.6875rem] leading-snug text-red-100/90">
              {truncateStack(error.stack)}
            </pre>
          </div>
        )}

        <button
          type="button"
          onClick={() => void copy()}
          className="mt-2 rounded border border-red-800/60 bg-red-900/30 px-2 py-1 text-[0.6875rem] font-medium text-red-100 hover:bg-red-900/60"
        >
          {copied ? 'Copied' : 'Copy details'}
        </button>
      </details>
    </div>
  )
}
