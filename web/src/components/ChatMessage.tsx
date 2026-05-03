import type { Message } from '../store/chat'

export function ChatMessage({ message }: { message: Message }) {
  const isUser = message.role === 'user'
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
        {message.content || (isUser ? '' : <span className="text-zinc-500">…</span>)}
        {!isUser && message.sources && message.sources.length > 0 && (
          <details className="mt-2 text-xs text-zinc-400">
            <summary className="cursor-pointer select-none">
              Sources ({message.sources.length})
            </summary>
            <ul className="mt-1 space-y-1">
              {message.sources.map((s) => (
                <li key={s.id}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-zinc-200"
                  >
                    {s.code ?? s.title}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  )
}
