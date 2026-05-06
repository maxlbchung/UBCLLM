import { Handle, Position, type NodeProps } from 'reactflow'

// Custom course-block node with named handles on all four sides. Used by
// the *root* of the prereq tree so prereq edges can land on the left
// while the coreq chain lands on the top — default ReactFlow nodes only
// expose a single targetPosition, which forces the bottommost coreq's
// edge to bend awkwardly into the left side.
//
// Non-root course nodes still use the default ReactFlow node type,
// because they only ever receive one kind of edge (either a horizontal
// prereq or a vertical coreq chain link, never both).

export interface CourseNodeData {
  label: string
  isRoot?: boolean
  known?: boolean
}

export function CourseNode({ data }: NodeProps<CourseNodeData>) {
  const { label, isRoot, known = true } = data
  const bg = isRoot ? '#1d4ed8' : known ? '#27272a' : '#3f1d1d'
  const border = isRoot ? '#1e40af' : known ? '#3f3f46' : '#7f1d1d'
  return (
    <div
      style={{
        background: bg,
        color: isRoot ? '#fff' : '#e5e7eb',
        border: `1px solid ${border}`,
        fontSize: isRoot ? 12 : 11,
        whiteSpace: 'pre-line',
        padding: isRoot ? 8 : 6,
        borderRadius: 6,
        width: 200,
        lineHeight: 1.3,
        textAlign: 'center',
      }}
    >
      {/* Order matters: left-target is rendered first, so edges that don't
          specify targetHandle fall through to it (prereqs default). */}
      <Handle type="target" id="left-target" position={Position.Left} />
      <Handle type="target" id="top-target" position={Position.Top} />
      <Handle type="source" id="right-source" position={Position.Right} />
      <Handle type="source" id="bottom-source" position={Position.Bottom} />
      {label}
    </div>
  )
}
