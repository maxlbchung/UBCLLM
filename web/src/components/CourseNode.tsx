import { Handle, Position, type NodeProps } from 'reactflow'
import { renderTextWithLinks } from '../lib/renderText'

// Custom course-block node with named handles on all four sides. Used for
// every course-shaped node in the prereq tree (root, prereqs, coreqs,
// note literals). The handles are visually hidden — they exist so edges
// can attach to the appropriate side regardless of where the connecting
// node lives, without each node having to reason about its own role.
//
// Variants:
//   - 'root'    blue, larger text, used for the queried course.
//   - 'known'   default dark — a known UBC course.
//   - 'unknown' dim dashed border with italic text — a course code
//               referenced in someone's prereqs but not present in the
//               corpus (e.g. high-school CALC 12). Same visual treatment
//               as 'note' since both are non-canonical references.
//   - 'note'    dashed muted border with italic text — used for class-
//               standing prose, "credits from" requirements, etc.
//               (literals that survive normalize and need to be visible).

export type CourseNodeVariant = 'root' | 'known' | 'unknown' | 'note'

export interface CourseNodeData {
  variant: CourseNodeVariant
  // For variants 'root' / 'known' / 'unknown': `code` is shown on top
  // and `title` underneath, separated by a thin horizontal divider
  // (same treatment as DisjunctionNode's selected-detail row).
  // For variant 'note': only `text` is used; `code` and `title` are
  // ignored.
  code?: string
  title?: string
  text?: string
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
  const { variant, code, title, text } = data
  const isRoot = variant === 'root'
  const isNote = variant === 'note'
  const isUnknown = variant === 'unknown'
  // Unknown-course blocks share the note variant's dim/dashed/italic look
  // — both are non-canonical references that shouldn't read as first-class
  // graph nodes. (Was previously a dark-red highlight, which incorrectly
  // flagged externally-valid prereqs like "CALC 12" as errors.)
  const dim = isNote || isUnknown

  const bg = isRoot ? '#1d4ed8' : dim ? '#1f1f23' : '#27272a'
  const border = isRoot ? '#1e40af' : dim ? '#52525b' : '#3f3f46'
  const color = isRoot ? '#fff' : dim ? '#a1a1aa' : '#e5e7eb'
  // Divider color picks the variant's border so it matches the block's
  // outline. For root the dark-blue border is too close to the blue bg
  // to read, so use a lighter blue for that case only.
  const divider = isRoot ? '#3b82f6' : border

  return (
    <div
      style={{
        background: bg,
        color,
        border: `1px ${dim ? 'dashed' : 'solid'} ${border}`,
        fontSize: isRoot ? 12 : 11,
        fontStyle: dim ? 'italic' : 'normal',
        whiteSpace: 'normal',
        // Match the dropdown block's effective text padding: its button
        // adds 3px vertical / 4px horizontal inside the container's 6px,
        // so dropdown text sits ~9px from the container edge. Mirror
        // that here so a course block doesn't look cramped next to a
        // dropdown sibling.
        padding: isRoot ? '10px 12px' : '9px 10px',
        borderRadius: 6,
        width: 200,
        lineHeight: 1.3,
        textAlign: isRoot ? 'center' : 'left',
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
      {isNote ? (
        text ? renderTextWithLinks(text) : null
      ) : (
        <>
          <div style={{ fontWeight: isUnknown ? 'normal' : 600 }}>{code}</div>
          {title && (
            <div
              style={{
                marginTop: 6,
                paddingTop: 6,
                borderTop: `1px solid ${divider}`,
              }}
            >
              {title}
            </div>
          )}
        </>
      )}
    </div>
  )
}
