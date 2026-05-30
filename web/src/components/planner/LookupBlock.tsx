// Draggable variant for mini-lookup results. Distinct from CourseBlock —
// it does NOT participate in any SortableContext (lookup results don't
// reorder), and dropping it on a term spawns a NEW PlannedBlock rather
// than moving an existing one. The DnD payload includes `kind: 'lookup'`
// so Planning.tsx's onDragEnd switches to the addBlock branch.
import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { parseCourseChunk, type Chunk } from '../../lib/retrieve'
import { CourseInfoPopup } from './CourseInfoPopup'

interface LookupBlockProps {
  chunk: Chunk
  ghost?: boolean
}

export function LookupBlock({ chunk, ghost = false }: LookupBlockProps) {
  const code = chunk.code ?? ''
  const course = parseCourseChunk(chunk)
  const { attributes, listeners, setNodeRef } =
    useDraggable({
      id: `lookup:${code}`,
      data: { kind: 'lookup', code },
      disabled: ghost,
    })
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  return (
    <div
      ref={ghost ? undefined : setNodeRef}
      {...(ghost ? {} : attributes)}
      {...(ghost ? {} : listeners)}
      className={`select-none rounded border border-line-soft bg-surface px-2 py-1.5 text-sm flex items-baseline gap-2 ${
        ghost ? 'shadow-lg' : 'cursor-grab active:cursor-grabbing hover:border-fg-faint'
      }`}
    >
      <span className="font-mono text-fg shrink-0">{code}</span>
      <span className="text-fg-muted truncate flex-1" title={course.title}>
        {course.title}
      </span>
      {!ghost && (
        <button
          type="button"
          aria-label="Show course details"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={(e) =>
            setAnchorRect(e.currentTarget.getBoundingClientRect())
          }
          onMouseLeave={() => setAnchorRect(null)}
          onFocus={(e) =>
            setAnchorRect(e.currentTarget.getBoundingClientRect())
          }
          onBlur={() => setAnchorRect(null)}
          className="shrink-0 w-4 h-4 rounded-full border border-fg-faint text-fg-muted hover:text-fg hover:border-fg-muted text-xs leading-none flex items-center justify-center cursor-help"
        >
          ?
        </button>
      )}
      {anchorRect && (
        <CourseInfoPopup course={course} anchorRect={anchorRect} />
      )}
    </div>
  )
}
