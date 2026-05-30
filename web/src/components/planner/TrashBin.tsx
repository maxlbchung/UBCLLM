// Droppable trash zone for the right sidebar. Lights up when a block is
// dragged over. The actual removal happens in Planning.tsx's onDragEnd
// when active.id is a block and over.id is 'trash'.
//
// `compact` is used by the collapsed-sidebar strip — just an icon-sized
// drop target with the same id so DnD still routes deletes through it.
import { useDroppable } from '@dnd-kit/core'
import { TrashIcon } from '../icons'

interface TrashBinProps {
  compact?: boolean
}

export function TrashBin({ compact = false }: TrashBinProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'trash',
    data: { kind: 'trash' },
  })
  if (compact) {
    return (
      <div
        ref={setNodeRef}
        title="Drop course here to delete"
        className={`w-full rounded border-2 border-dashed p-1 text-center text-sm transition-colors ${
          isOver
            ? 'border-danger-fg bg-danger-soft text-danger-fg'
            : 'border-line-soft text-fg-faint'
        }`}
      >
        <TrashIcon className="w-4 h-4 mx-auto" />
      </div>
    )
  }
  return (
    <div
      ref={setNodeRef}
      className={`rounded border-2 border-dashed p-4 text-center text-sm transition-colors ${
        isOver
          ? 'border-danger-fg bg-danger-soft text-danger-fg'
          : 'border-line-soft bg-surface text-fg-faint'
      }`}
    >
      <span className="flex items-center justify-center gap-1.5">
        <TrashIcon className="w-4 h-4" />
        Drop course here to delete
      </span>
    </div>
  )
}
