import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from 'reactflow'

// Custom edge for soft (optional) prereq connections. Renders the dashed
// path that signals the upstream is optional and overlays a small HTML
// "optional" pill at the path midpoint. Clicking the pill toggles the
// soft branch — when toggled off, the edge stays put but its source node
// renders faded and its upstream prereqs aren't loaded.
//
// The pill is rendered through `EdgeLabelRenderer` (an absolutely-
// positioned overlay outside the SVG layer) so it can be a real button
// element rather than an SVG <text>; that's what makes it interactive
// at the same DOM tier as the rest of the graph's HTML controls.

export interface SoftEdgeData {
  softKey: string
  disabled: boolean
  onToggle: (key: string) => void
}

export function SoftEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data,
}: EdgeProps<SoftEdgeData>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  const { softKey, disabled, onToggle } = data!
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            // The label-renderer overlay defaults to pointer-events:none
            // so panning still works through it. Re-enable on the pill so
            // its clicks register.
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
        >
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(softKey)
            }}
            style={{
              // Always opaque so the pill masks the dashed edge running
              // through it. Disabled state uses the graph canvas color
              // (bg-zinc-950 from the wrapper) so the pill blends into
              // empty space; enabled state stays at the node-bg shade
              // so it reads as "filled in" against the dashed line.
              background: disabled ? '#09090b' : '#27272a',
              border: '1px dashed #52525b',
              color: '#a1a1aa',
              padding: '3px 7px',
              borderRadius: 4,
              fontSize: 10,
              lineHeight: 1.2,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontStyle: 'italic',
              whiteSpace: 'nowrap',
            }}
          >
            {disabled ? '+ optional' : '− optional'}
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
