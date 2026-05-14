import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Children } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message } from '../store/chat'
import type { Chunk } from '../lib/retrieve'
import { playSfx } from '../lib/sfx'
import { ErrorDetails } from './ErrorDetails'

const CITATION_RE = /\[(\d+)\]/g

const ICON_CLASS =
  'shrink-0 w-6 h-6 mt-1 text-fg-faint [&>svg]:w-full [&>svg]:h-full'

function BotIcon() {
  return (
    <div className={ICON_CLASS} aria-hidden>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4" y="8" width="16" height="12" rx="2" />
        <line x1="12" y1="4" x2="12" y2="8" />
        <circle cx="9" cy="14" r="0.75" fill="currentColor" stroke="none" />
        <circle cx="15" cy="14" r="0.75" fill="currentColor" stroke="none" />
      </svg>
    </div>
  )
}

function UserIcon() {
  return (
    <div className={ICON_CLASS} aria-hidden>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="9" r="3.5" />
        <path d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6" />
      </svg>
    </div>
  )
}

function citationChip(idx: number, sources: Chunk[], key: string | number): ReactNode {
  const src = sources[idx - 1]
  if (!src) return `[${idx}]`
  // Hand-curated easter-egg chunks (pipeline/easter-eggs.json) get the
  // highlight palette so they're visually distinct from scraped
  // course/program chunks (which use the accent palette).
  const isEaster = src.kind === 'easter'
  const chipClasses = isEaster
    ? 'bg-highlight-soft text-highlight-soft-fg hover:bg-highlight/60 hover:text-accent-fg'
    : 'bg-accent-soft text-accent-soft-fg hover:bg-accent-hover/60 hover:text-accent-fg'
  const baseClasses =
    'inline-block align-super text-[0.625rem] font-mono px-1 mx-0.5 rounded no-underline'
  // Easter chunks usually have no source URL — render as a plain span so an
  // empty href doesn't navigate the user to the current page on click.
  if (!src.url) {
    return (
      <span
        key={key}
        title={src.code ?? src.title}
        onClick={() => playSfx('click')}
        className={`${baseClasses} ${chipClasses} cursor-pointer`}
      >
        {idx}
      </span>
    )
  }
  return (
    <a
      key={key}
      href={src.url}
      target="_blank"
      rel="noopener noreferrer"
      title={src.code ?? src.title}
      onClick={() => playSfx('click')}
      className={`${baseClasses} ${chipClasses}`}
    >
      {idx}
    </a>
  )
}

/**
 * Replace `[N]` markers in a plain string with citation chips. Out-of-range
 * numbers and stray brackets stay as literal text.
 */
function injectCitations(text: string, sources: Chunk[]): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  CITATION_RE.lastIndex = 0
  while ((m = CITATION_RE.exec(text)) !== null) {
    const idx = Number(m[1])
    const inRange = idx >= 1 && idx <= sources.length
    if (m.index > last) out.push(text.slice(last, m.index))
    if (inRange) out.push(citationChip(idx, sources, `cit-${m.index}`))
    else out.push(m[0])
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * Walk immediate children of a markdown element and decorate any string
 * children with citation chips. Nested elements keep their own component
 * overrides so decoration recurses naturally.
 */
function decorate(children: ReactNode, sources: Chunk[]): ReactNode {
  return Children.map(children, (child, i) => {
    if (typeof child === 'string') {
      return <span key={`txt-${i}`}>{injectCitations(child, sources)}</span>
    }
    return child
  })
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

function buildComponents(sources: Chunk[]): Components {
  const dec = (children: ReactNode) => decorate(children, sources)
  return {
    p: ({ children, ...rest }: ComponentPropsWithoutRef<'p'>) => (
      <p className="my-2 first:mt-0 last:mb-0" {...rest}>
        {dec(children)}
      </p>
    ),
    ul: ({ children, ...rest }: ComponentPropsWithoutRef<'ul'>) => (
      <ul className="list-disc pl-5 my-2 space-y-1" {...rest}>
        {children}
      </ul>
    ),
    ol: ({ children, ...rest }: ComponentPropsWithoutRef<'ol'>) => (
      <ol className="list-decimal pl-5 my-2 space-y-1" {...rest}>
        {children}
      </ol>
    ),
    li: ({ children, ...rest }: ComponentPropsWithoutRef<'li'>) => (
      <li {...rest}>{dec(children)}</li>
    ),
    strong: ({ children, ...rest }: ComponentPropsWithoutRef<'strong'>) => (
      <strong className="font-semibold" {...rest}>
        {dec(children)}
      </strong>
    ),
    em: ({ children, ...rest }: ComponentPropsWithoutRef<'em'>) => (
      <em className="italic" {...rest}>
        {dec(children)}
      </em>
    ),
    del: ({ children, ...rest }: ComponentPropsWithoutRef<'del'>) => (
      <del {...rest}>{dec(children)}</del>
    ),
    h1: ({ children, ...rest }: ComponentPropsWithoutRef<'h1'>) => (
      <h1 className="text-base font-semibold mt-3 mb-1" {...rest}>
        {dec(children)}
      </h1>
    ),
    h2: ({ children, ...rest }: ComponentPropsWithoutRef<'h2'>) => (
      <h2 className="text-base font-semibold mt-3 mb-1" {...rest}>
        {dec(children)}
      </h2>
    ),
    h3: ({ children, ...rest }: ComponentPropsWithoutRef<'h3'>) => (
      <h3 className="text-sm font-semibold mt-2 mb-1" {...rest}>
        {dec(children)}
      </h3>
    ),
    h4: ({ children, ...rest }: ComponentPropsWithoutRef<'h4'>) => (
      <h4 className="text-sm font-semibold mt-2 mb-1" {...rest}>
        {dec(children)}
      </h4>
    ),
    h5: ({ children, ...rest }: ComponentPropsWithoutRef<'h5'>) => (
      <h5 className="text-sm font-semibold mt-2 mb-1" {...rest}>
        {dec(children)}
      </h5>
    ),
    h6: ({ children, ...rest }: ComponentPropsWithoutRef<'h6'>) => (
      <h6 className="text-sm font-semibold mt-2 mb-1" {...rest}>
        {dec(children)}
      </h6>
    ),
    a: ({ href, children, ...rest }: ComponentPropsWithoutRef<'a'>) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline text-link hover:text-accent-soft-fg"
        {...rest}
      >
        {children}
      </a>
    ),
    code: ({ children, ...rest }: ComponentPropsWithoutRef<'code'>) => (
      <code
        className="px-1 py-0.5 rounded bg-surface/70 font-mono text-[0.85em]"
        {...rest}
      >
        {children}
      </code>
    ),
    pre: ({ children, ...rest }: ComponentPropsWithoutRef<'pre'>) => (
      <pre
        className="my-2 p-2 rounded bg-surface/70 overflow-x-auto text-xs font-mono"
        {...rest}
      >
        {children}
      </pre>
    ),
    blockquote: ({ children, ...rest }: ComponentPropsWithoutRef<'blockquote'>) => (
      <blockquote
        className="border-l-2 border-fg-faint pl-3 my-2 text-fg-muted"
        {...rest}
      >
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-3 border-line-soft" />,
    table: ({ children, ...rest }: ComponentPropsWithoutRef<'table'>) => (
      <div className="my-2 overflow-x-auto">
        <table className="border-collapse text-xs" {...rest}>
          {children}
        </table>
      </div>
    ),
    th: ({ children, ...rest }: ComponentPropsWithoutRef<'th'>) => (
      <th
        className="px-2 py-1 border border-line-soft text-left font-semibold bg-surface-soft"
        {...rest}
      >
        {dec(children)}
      </th>
    ),
    td: ({ children, ...rest }: ComponentPropsWithoutRef<'td'>) => (
      <td className="px-2 py-1 border border-line-soft align-top" {...rest}>
        {dec(children)}
      </td>
    ),
  }
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
    <div
      className={
        'flex items-start gap-2 ' + (isUser ? 'justify-end' : 'justify-start')
      }
    >
      {!isUser && <BotIcon />}
      <div
        className={
          'rounded-lg px-3 py-2 max-w-[85%] text-sm leading-relaxed ' +
          (isUser
            ? 'bg-accent text-accent-fg whitespace-pre-wrap'
            : 'bg-surface-raised text-fg border border-line-soft')
        }
      >
        {message.content ? (
          isUser ? (
            message.content
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={buildComponents(sources)}
            >
              {message.content}
            </ReactMarkdown>
          )
        ) : (
          !isUser &&
          // Suppress the thinking-dots animation once an error/timeout
          // lands on this message — the streamed delta will never arrive,
          // and a bouncing indicator next to a "Sources retrieved" + error
          // block reads as if the model is still working.
          !message.error && (
            <span
              className="inline-flex items-center gap-1 text-fg-faint"
              aria-label="Thinking"
              role="status"
            >
              {[0, 160, 320].map((delay) => (
                <span
                  key={delay}
                  className="inline-block h-1.5 w-1.5 rounded-full bg-current"
                  style={{
                    animation: 'thinking-dot 1200ms ease-in-out infinite',
                    animationDelay: `${delay}ms`,
                  }}
                />
              ))}
            </span>
          )
        )}

        {!isUser && sources.length > 0 && (
          <details
            className="mt-2 text-xs text-fg-muted"
            onToggle={(e) => {
              if (!e.currentTarget.open) return
              const el = e.currentTarget
              // Defer one frame so the expanded content has laid out before
              // we measure. scrollIntoView with block:'nearest' is a no-op
              // when the element is already fully visible — it only scrolls
              // the minimum needed to bring the bottom (or top) into view.
              requestAnimationFrame(() => {
                el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
              })
            }}
          >
            <summary
              className="cursor-pointer select-none"
              onClick={() => playSfx('toggle')}
            >
              {cited1Indexed.length > 0
                ? `Sources used (${cited1Indexed.length} of ${sources.length})`
                : `Sources retrieved (${sources.length})`}
            </summary>

            {cited1Indexed.length > 0 && (
              <ul className="mt-1 space-y-1">
                {cited1Indexed.map(({ s, i }) => {
                  const isEaster = s.kind === 'easter'
                  const indexClass = isEaster
                    ? 'text-[0.625rem] font-mono text-highlight-fg w-4 text-right'
                    : 'text-[0.625rem] font-mono text-link/90 w-4 text-right'
                  const labelClass = isEaster
                    ? 'underline text-highlight-fg hover:text-highlight'
                    : 'underline hover:text-fg text-fg'
                  const label = s.code ?? s.title
                  return (
                    <li key={s.id} className="flex items-baseline gap-1.5">
                      <span className={indexClass}>[{i}]</span>
                      {s.url ? (
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={labelClass}
                        >
                          {label}
                        </a>
                      ) : (
                        <span className={labelClass.replace('underline ', '')}>
                          {label}
                        </span>
                      )}
                      {s.score != null && (
                        <span
                          className="ml-auto text-[0.625rem] font-mono text-fg-faint"
                          title="Retrieval score (cosine similarity, plus optional title-match and course-keyword boosts; pure cosine is in [-1, 1])"
                        >
                          {s.score.toFixed(3)}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}

            {uncited.length > 0 && (
              <>
                <p className="mt-2 text-[0.625rem] uppercase tracking-wider text-fg-faint">
                  Other retrieved context
                </p>
                <ul className="mt-1 space-y-1 opacity-60">
                  {uncited.map(({ s, i }) => {
                    const isEaster = s.kind === 'easter'
                    const indexClass = isEaster
                      ? 'text-[0.625rem] font-mono text-highlight/70 w-4 text-right'
                      : 'text-[0.625rem] font-mono text-fg-faint w-4 text-right'
                    const labelClass = isEaster
                      ? 'underline text-highlight-fg/80 hover:text-highlight'
                      : 'underline hover:text-fg-muted'
                    const label = s.code ?? s.title
                    return (
                      <li key={s.id} className="flex items-baseline gap-1.5">
                        <span className={indexClass}>[{i}]</span>
                        {s.url ? (
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={labelClass}
                          >
                            {label}
                          </a>
                        ) : (
                          <span className={labelClass.replace('underline ', '')}>
                            {label}
                          </span>
                        )}
                        {s.score != null && (
                          <span
                            className="ml-auto text-[0.625rem] font-mono text-fg-faint"
                            title="Retrieval score (cosine similarity, plus optional title-match and course-keyword boosts; pure cosine is in [-1, 1])"
                          >
                            {s.score.toFixed(3)}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </details>
        )}

        {!isUser && message.error && <ErrorDetails error={message.error} />}
      </div>
      {isUser && <UserIcon />}
    </div>
  )
}
