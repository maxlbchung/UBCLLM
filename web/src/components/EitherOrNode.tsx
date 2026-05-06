import { Handle, Position, type NodeProps } from 'reactflow'

// ReactFlow custom node for an `Or-stacked` group — used when the prereq
// string says "Either (a) … or (b) …". Renders as one container holding
// stacked sub-blocks (one per option), each with a radio-style circle on
// the left. The selected sub-block is full opacity; the rest are dimmed.
// Clicking anywhere on a sub-block selects it, which triggers a graph
// rebuild in the parent so the upstream subtree reflects the new choice.

export interface EitherOrOption {
  // Letter label parsed off the source ("(a)", "(b)", …). Empty string if
  // the source didn't have an explicit label (we still index by position).
  label: string
  // Flattened display of the courses / literals in this branch — e.g.
  // "PHYS 101 / 106 / 107 + MATH 101 / 103" or "SCIE 001". Built by
  // displayExpr() from prereqAst.ts.
  display: string
}

export interface EitherOrData {
  options: EitherOrOption[]
  selectedIdx: number
  onChange: (idx: number) => void
  // See DisjunctionNode for the meaning of orientation.
  orientation?: 'horizontal' | 'vertical'
}

export function EitherOrNode({ data }: NodeProps<EitherOrData>) {
  const { options, selectedIdx, onChange, orientation = 'horizontal' } = data
  const targetPos = orientation === 'vertical' ? Position.Top : Position.Left
  const sourcePos = orientation === 'vertical' ? Position.Bottom : Position.Right
  return (
    <div
      style={{
        background: '#1f1c2c',
        border: '1px solid #71717a',
        borderRadius: 6,
        padding: 6,
        width: 200,
        color: '#e5e7eb',
        fontSize: 11,
        textAlign: 'left',
      }}
    >
      <Handle type="target" position={targetPos} />
      <div
        style={{
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: '#a1a1aa',
          marginBottom: 4,
        }}
      >
        either
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {options.map((opt, i) => {
          const selected = i === selectedIdx
          return (
            <div
              key={i}
              onClick={() => onChange(i)}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                padding: '4px 6px',
                borderRadius: 4,
                cursor: 'pointer',
                background: selected ? '#27272a' : 'transparent',
                opacity: selected ? 1 : 0.45,
                border: selected
                  ? '1px solid #52525b'
                  : '1px solid transparent',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  border: '2px solid #71717a',
                  background: selected ? '#3b82f6' : 'transparent',
                  marginTop: 2,
                }}
              />
              <span style={{ lineHeight: 1.3 }}>
                {opt.label && (
                  <span style={{ color: '#a1a1aa', marginRight: 4 }}>
                    ({opt.label})
                  </span>
                )}
                {opt.display}
              </span>
            </div>
          )
        })}
      </div>
      <Handle type="source" position={sourcePos} />
    </div>
  )
}
