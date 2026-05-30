// One term inside a year column — a droppable container with a sortable
// list of CourseBlocks. The drop target id encodes the term coordinates
// so onDragEnd in Planning.tsx can route the move/add to the right slot.
import { useState } from 'react'
import { useDndMonitor, useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CourseBlock } from './CourseBlock'
import { EMPTY_VALIDATION, type BlockValidation } from './validation'
import type { Chunk } from '../../lib/retrieve'
import type { Term, TermSeason } from '../../store/planner'

const SEASON_LABEL: Record<TermSeason, string> = {
  fall: 'Term 1',
  spring: 'Term 2',
  summer: 'Summer',
}

interface TermSectionProps {
  yearId: string
  termIdx: number
  term: Term
  courseIndex: Map<string, Chunk>
  validations: Map<string, BlockValidation>
}

export function TermSection({
  yearId,
  termIdx,
  term,
  courseIndex,
  validations,
}: TermSectionProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `term:${yearId}:${termIdx}`,
    data: { kind: 'term', yearId, termIdx },
  })
  const blockIds = term.blocks.map((b) => `block:${b.id}`)

  // useDroppable's `isOver` only fires when the drop target is this term
  // container itself. When the user drags over a block *inside* the term,
  // dnd-kit's collision resolves to that block (which is also droppable
  // via useSortable), so the term stays unhighlighted even though it's
  // the destination. Listen to drag events and also light up when one of
  // our descendant blocks is the active over-target.
  const [isOverDescendant, setIsOverDescendant] = useState(false)
  useDndMonitor({
    onDragMove(event) {
      const rawOver = event.over?.id
      if (rawOver == null) {
        setIsOverDescendant(false)
        return
      }
      const overId = String(rawOver)
      if (overId.startsWith('block:')) {
        const id = overId.slice('block:'.length)
        setIsOverDescendant(term.blocks.some((b) => b.id === id))
      } else {
        setIsOverDescendant(false)
      }
    },
    onDragEnd() {
      setIsOverDescendant(false)
    },
    onDragCancel() {
      setIsOverDescendant(false)
    },
  })
  const highlighted = isOver || isOverDescendant
  const creditTotal = term.blocks.reduce((sum, b) => {
    const chunk = courseIndex.get(b.code)
    if (!chunk) return sum
    // Parse just the leading number off the credits string ("3" → 3,
    // "3-6" → 3, missing → 0). Variable-credit courses count their
    // floor; close enough for a planner subtotal.
    const text = chunk.text
    const m = text.match(/Credits:\s*(\d+)/)
    return sum + (m ? Number(m[1]) : 0)
  }, 0)
  return (
    <div
      ref={setNodeRef}
      className={`rounded border ${
        highlighted ? 'border-accent bg-accent-soft' : 'border-line bg-surface-soft'
      } p-2 flex flex-col gap-1.5 flex-1 min-h-[6rem]`}
    >
      <div className="flex items-baseline justify-between text-xs shrink-0">
        <span className="text-fg-muted">{SEASON_LABEL[term.season]}</span>
        <span className="text-fg-faint">Credits: {creditTotal}</span>
      </div>
      <SortableContext
        items={blockIds}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex-1 min-h-0 flex flex-col gap-1 overflow-y-auto">
          {term.blocks.map((b) => (
            <CourseBlock
              key={b.id}
              blockId={b.id}
              code={b.code}
              chunk={courseIndex.get(b.code)}
              validation={validations.get(b.id) ?? EMPTY_VALIDATION}
            />
          ))}
          {term.blocks.length === 0 && (
            <p className="text-xs text-fg-faint italic px-1 py-2">
              Drag courses here
            </p>
          )}
        </div>
      </SortableContext>
    </div>
  )
}
