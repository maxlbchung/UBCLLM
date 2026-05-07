import { Handle, Position, type NodeProps } from 'reactflow'

// Custom course-block node with named handles on all four sides. Used for
// every course-shaped node in the prereq tree (root, prereqs, coreqs,
// note literals). The handles are visually hidden — they exist so edges
// can attach to the appropriate side regardless of where the connecting
// node lives, without each node having to reason about its own role.
//
// Variants:
//   - 'root'    blue, larger text, used for the queried course.
//   - 'known'   default dark — a known UBC course.
//   - 'unknown' dark red — a course code referenced in someone's prereqs
//               but not present in the corpus.
//   - 'note'    dashed muted border with italic text — used for class-
//               standing prose, "credits from" requirements, etc.
//               (literals that survive normalize and need to be visible).

export type CourseNodeVariant = 'root' | 'known' | 'unknown' | 'note'

export interface CourseNodeData {
  label: string
  variant: CourseNodeVariant
}

const HANDLE_STYLE = {
  opacity: 0,
  width: 8,
  height: 8,
  border: 'none',
  background: 'transparent',
  pointerEvents: 'none' as const,
}

export function CourseNode({ data }: NodeProps<CourseNodeData>) {
  const { label, variant } = data
  const isRoot = variant === 'root'
  const isNote = variant === 'note'
  const known = variant !== 'unknown'

  const bg = isRoot
    ? '#1d4ed8'
    : isNote
      ? '#1f1f23'
      : known
        ? '#27272a'
        : '#3f1d1d'
  const border = isRoot
    ? '#1e40af'
    : isNote
      ? '#52525b'
      : known
        ? '#3f3f46'
        : '#7f1d1d'
  const color = isRoot ? '#fff' : isNote ? '#a1a1aa' : '#e5e7eb'

  return (
    <div
      style={{
        background: bg,
        color,
        border: `1px ${isNote ? 'dashed' : 'solid'} ${border}`,
        fontSize: isRoot ? 12 : 11,
        fontStyle: isNote ? 'italic' : 'normal',
        whiteSpace: isNote ? 'normal' : 'pre-line',
        padding: isRoot ? 8 : 6,
        borderRadius: 6,
        width: 200,
        // Match the previous look: course nodes are center-aligned (this
        // was the implicit inherit from ReactFlow's default node style
        // before non-root nodes started using this custom component).
        // Only the root carries an explicit line-height bump.
        textAlign: 'center',
        ...(isRoot ? { lineHeight: 1.3 } : {}),
      }}
    >
      {/* Order matters: left-target is rendered first, so edges that
          don't specify targetHandle fall through to it (prereq default).
          Listing left/right then top/bottom keeps the horizontal flow
          (prereqs in, prereqs/successors out) as the implicit default. */}
      <Handle type="target" id="left-target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle type="target" id="top-target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle type="source" id="right-source" position={Position.Right} style={HANDLE_STYLE} />
      <Handle type="source" id="bottom-source" position={Position.Bottom} style={HANDLE_STYLE} />
      {renderLabel(label, isNote)}
    </div>
  )
}

// Course-block labels arrive as `${code}\n${title}` (or just text for the
// note variant). Bold the first line so the course code visually leads
// the block. Notes have no code, just prose, so they render unstyled.
function renderLabel(label: string, isNote: boolean) {
  if (isNote) return label
  const idx = label.indexOf('\n')
  if (idx === -1) return <strong>{label}</strong>
  return (
    <>
      <strong>{label.slice(0, idx)}</strong>
      {label.slice(idx)}
    </>
  )
}
