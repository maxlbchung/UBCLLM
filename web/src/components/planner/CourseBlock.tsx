// Single draggable course block inside a term. The block re-resolves its
// title/credits against the live course index at render time (we persist
// only the code), so a refreshed corpus flows through to existing plans.
//
// The red-border + tooltip is the planner's only signal that prereqs
// aren't met — see Planning.tsx for the cumulative-completed-set logic
// that fills `validation`.
import { useMemo, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { parseCourseChunk, type Chunk } from '../../lib/retrieve'
import { parsePrereq } from '../../lib/prereqAst'
import type { BlockValidation } from './validation'
import { CourseInfoPopup } from './CourseInfoPopup'
import { playSfx } from '../../lib/sfx'

interface CourseBlockProps {
  blockId: string
  code: string
  chunk: Chunk | undefined
  validation: BlockValidation
  fulfillsRequirement?: boolean
  ghost?: boolean
}

export function CourseBlock({
  blockId,
  code,
  chunk,
  validation,
  fulfillsRequirement = false,
  ghost = false,
}: CourseBlockProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `block:${blockId}`, data: { kind: 'block', blockId } })

  const parsed = chunk ? parseCourseChunk(chunk) : null
  const title = parsed?.title || code
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  const borderClass = !validation.ok
    ? 'border-danger-fg'
    : fulfillsRequirement
      ? 'border-line hover:border-line-soft'
      : 'border-white hover:border-white'

  // Parse prereq/coreq trees once per block so the popup can render
  // them with clause-level highlighting against the snapshot completed
  // sets we stash on validation. Parsing is cheap and only runs when
  // the chunk's text changes.
  const prereqAst = useMemo(
    () => parsePrereq(parsed?.prerequisites),
    [parsed?.prerequisites],
  )
  const coreqAst = useMemo(
    () => parsePrereq(parsed?.corequisites),
    [parsed?.corequisites],
  )

  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)

  function togglePopup(e: React.MouseEvent | React.FocusEvent) {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setAnchorRect((prev) => {
      playSfx(prev ? 'courseCollapse' : 'courseExpand')
      return prev ? null : rect
    })
  }

  return (
    <div
      ref={ghost ? undefined : setNodeRef}
      style={ghost ? undefined : style}
      {...(ghost ? {} : attributes)}
      {...(ghost ? {} : listeners)}
      className={`group select-none cursor-grab active:cursor-grabbing rounded border ${borderClass} bg-surface-raised px-2 py-1.5 text-sm flex items-baseline gap-2 w-full shrink-0 ${
        ghost ? 'shadow-lg' : ''
      }`}
    >
      <span className="font-mono text-fg shrink-0">{code}</span>
      <span className="text-fg-muted truncate flex-1">
        {title}
      </span>
      {!ghost && parsed && (
        <button
          type="button"
          aria-label="Show course details"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={togglePopup}
          className={`shrink-0 w-4 h-4 rounded-full border text-xs leading-none flex items-center justify-center transition-colors ${
            anchorRect
              ? 'border-fg-muted text-fg bg-surface-raised'
              : 'border-fg-faint text-fg-muted hover:text-fg hover:border-fg-muted'
          }`}
        >
          ?
        </button>
      )}
      {anchorRect && parsed && (
        <CourseInfoPopup
          course={parsed}
          anchorRect={anchorRect}
          prereqAst={prereqAst}
          coreqAst={coreqAst}
          completedBefore={validation.completedBefore}
          completedSameOrBefore={validation.completedSameOrBefore}
          onClose={() => setAnchorRect(null)}
        />
      )}
    </div>
  )
}
