import { Handle, Position, type NodeProps } from 'reactflow'

// ReactFlow custom node for an `Or-dropdown` group — used when the prereq
// string says "one of A, B, C" (or a bare "A or B" without a wrapping
// "either"). Renders as a single block with a <select> that lets the user
// pick which option the upstream subtree should expand. Width matches
// NODE_WIDTH in PrereqTree so column-layout x-coordinates stay valid.

export interface DisjunctionOption {
  display: string
  // Whether this option resolves to a course code (drives upstream
  // expansion) vs. a literal like "3rd-year standing" (no edges drawn from
  // this block when selected).
  isCode: boolean
}

// What the user sees underneath the dropdown — the resolved detail of the
// option currently selected. The dropdown block IS the selected course's
// node in the graph (no separate trailing course node), so this row carries
// the same information a regular course node would: title, or a fallback
// for unknown / literal options.
export type DisjunctionDetail =
  | { kind: 'course'; code: string; title: string | null }
  | { kind: 'literal'; text: string }
  | null

export interface DisjunctionData {
  options: DisjunctionOption[]
  selectedIdx: number
  onChange: (idx: number) => void
  detail: DisjunctionDetail
  // Direction edges flow into / out of this block. 'horizontal' (default)
  // places target on the left and source on the right — used by the
  // prereq chain. 'vertical' is used by the coreq stack so blocks chain
  // top-to-bottom.
  orientation?: 'horizontal' | 'vertical'
}

export function DisjunctionNode({ data }: NodeProps<DisjunctionData>) {
  const { options, selectedIdx, onChange, detail, orientation = 'horizontal' } = data
  const detailKnown = detail?.kind === 'course' && detail.title !== null
  const detailUnknownCourse =
    detail?.kind === 'course' && detail.title === null
  const bg = detailUnknownCourse ? '#3f1d1d' : '#27272a'
  const border = detailUnknownCourse ? '#7f1d1d' : '#3f3f46'
  const targetPos = orientation === 'vertical' ? Position.Top : Position.Left
  const sourcePos = orientation === 'vertical' ? Position.Bottom : Position.Right
  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${border}`,
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
        one of
      </div>
      <select
        value={selectedIdx}
        onChange={(e) => onChange(Number(e.target.value))}
        // Native <select> in a ReactFlow node — stop pointer events from
        // bubbling to the canvas pan/zoom handlers when the user opens it.
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          background: '#18181b',
          border: '1px solid #3f3f46',
          color: '#e5e7eb',
          padding: '3px 4px',
          borderRadius: 4,
          fontSize: 11,
        }}
      >
        {options.map((opt, i) => (
          <option key={i} value={i}>
            {opt.display}
          </option>
        ))}
      </select>
      {detail && (
        <div
          style={{
            marginTop: 6,
            paddingTop: 6,
            borderTop: '1px solid #3f3f46',
            fontSize: 11,
            lineHeight: 1.3,
            color: detailKnown ? '#e5e7eb' : '#a1a1aa',
            fontStyle: detail.kind === 'literal' ? 'italic' : 'normal',
          }}
        >
          {detail.kind === 'course'
            ? (detail.title ?? '(not in calendar)')
            : detail.text}
        </div>
      )}
      <Handle type="source" position={sourcePos} />
    </div>
  )
}
