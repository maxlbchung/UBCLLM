import type { ReactNode } from 'react'
import type { Message } from '../store/chat'
import type { Chunk } from '../lib/retrieve'

const CITATION_RE = /\[(\d+)\]/g

/**
 * Walk the assistant text, replacing every `[N]` (where 1 ≤ N ≤ sources.length)
 * with a clickable superscript anchor that opens the cited chunk's UBC URL.
 * Out-of-range numbers and stray brackets stay as literal text.
 */
function renderWithCitations(content: string, sources: Chunk[]): ReactNode[] {
  const parts: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  CITATION_RE.lastIndex = 0
  while ((m = CITATION_RE.exec(content)) !== null) {
    const idx = Number(m[1]) - 1
    const inRange = idx >= 0 && idx < sources.length
    if (m.index > last) parts.push(content.slice(last, m.index))
    if (inRange) {
      const src = sources[idx]
      parts.push(
        <a
          key={`cit-${m.index}`}
          href={src.url}
          target="_blank"
          rel="noopener noreferrer"
          title={src.code ?? src.title}
          className="inline-block align-super text-[10px] font-mono px-1 mx-0.5 rounded bg-blue-500/30 text-blue-200 hover:bg-blue-500/60 hover:text-white no-underline"
        >
          {idx + 1}
        </a>,
      )
    } else {
      parts.push(m[0])
    }
    last = m.index + m[0].length
  }
  if (last < content.length) parts.push(content.slice(last))
  return parts
}

function citedIndices(content: string, sourceCount: number): Set<number> {
  const out = new Set<number>()
  CITATION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CITATION_RE.exec(content)) !== null) {
    const i = Number(m[1])
    if (i >= 1 && i <= sourceCount) out.add(i)
  }
  return out
}

export function ChatMessage({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  const sources = message.sources ?? []
  const cited = citedIndices(message.content, sources.length)

  const cited1Indexed = sources
    .map((s, i) => ({ s, i: i + 1 }))
    .filter(({ i }) => cited.has(i))
  const uncited = sources
    .map((s, i) => ({ s, i: i + 1 }))
    .filter(({ i }) => !cited.has(i))

  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          'rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap text-sm leading-relaxed ' +
          (isUser
            ? 'bg-blue-600 text-white'
            : 'bg-zinc-800 text-zinc-100 border border-zinc-700')
        }
      >
        {message.content
          ? isUser
            ? message.content
            : renderWithCitations(message.content, sources)
          : !isUser && <span className="text-zinc-500">…</span>}

        {!isUser && sources.length > 0 && (
          <details className="mt-2 text-xs text-zinc-400" open={cited1Indexed.length > 0}>
            <summary className="cursor-pointer select-none">
              {cited1Indexed.length > 0
                ? `Sources used (${cited1Indexed.length} of ${sources.length})`
                : `Sources retrieved (${sources.length})`}
            </summary>

            {cited1Indexed.length > 0 && (
              <ul className="mt-1 space-y-1">
                {cited1Indexed.map(({ s, i }) => (
                  <li key={s.id} className="flex items-baseline gap-1.5">
                    <span className="text-[10px] font-mono text-blue-300/90 w-4 text-right">
                      [{i}]
                    </span>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-zinc-200 text-zinc-200"
                    >
                      {s.code ?? s.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {uncited.length > 0 && (
              <>
                <p className="mt-2 text-[10px] uppercase tracking-wider text-zinc-600">
                  Other retrieved context
                </p>
                <ul className="mt-1 space-y-1 opacity-60">
                  {uncited.map(({ s, i }) => (
                    <li key={s.id} className="flex items-baseline gap-1.5">
                      <span className="text-[10px] font-mono text-zinc-600 w-4 text-right">
                        [{i}]
                      </span>
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-zinc-300"
                      >
                        {s.code ?? s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </details>
        )}
      </div>
    </div>
  )
}
