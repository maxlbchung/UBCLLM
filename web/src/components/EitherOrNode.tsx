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
}

const HANDLE_STYLE = {
  opacity: 0,
  width: 8,
  height: 8,
  border: 'none',
  background: 'transparent',
  pointerEvents: 'none' as const,
}

export function EitherOrNode({ data }: NodeProps<EitherOrData>) {
  const { options, selectedIdx, onChange } = data
  return (
    <div
      style={{
        // Was a unique purple tint (#1f1c2c) in v1.5; that custom hue
        // isn't in our token palette, so EitherOr now shares the
        // surface tone with DisjunctionNode and relies on the stacked
        // radio layout for visual distinction. Border bumps to
        // --fg-faint (zinc-500) to stay a touch more present than a
        // regular --line-soft block.
        background: 'var(--surface)',
        border: '1px solid var(--fg-faint)',
        borderRadius: 6,
        padding: 6,
        width: 200,
        color: 'var(--fg)',
        fontSize: 11,
        textAlign: 'left',
      }}
    >
      {/* Invisible handles on all four sides — same pattern as
          CourseNode / DisjunctionNode. */}
      <Handle type="target" id="left-target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle type="target" id="top-target" position={Position.Top} style={HANDLE_STYLE} />
      <div
        style={{
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--fg-muted)',
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
                background: selected ? 'var(--surface-raised)' : 'transparent',
                opacity: selected ? 1 : 0.45,
                border: selected
                  ? '1px solid var(--fg-faint)'
                  : '1px solid transparent',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  border: '2px solid var(--fg-faint)',
                  background: selected ? 'var(--accent-hover)' : 'transparent',
                  marginTop: 2,
                }}
              />
              <span style={{ lineHeight: 1.3 }}>
                {opt.label && (
                  <span style={{ color: 'var(--fg-muted)', marginRight: 4 }}>
                    ({opt.label})
                  </span>
                )}
                {opt.display}
              </span>
            </div>
          )
        })}
      </div>
      <Handle type="source" id="right-source" position={Position.Right} style={HANDLE_STYLE} />
      <Handle type="source" id="bottom-source" position={Position.Bottom} style={HANDLE_STYLE} />
    </div>
  )
}
