import { useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from 'reactflow'
import { renderTextWithLinks } from '../lib/renderText'
import { playSfx } from '../lib/sfx'

// ReactFlow custom node for an `Or-dropdown` group — used when the prereq
// string says "one of A, B, C" (or a bare "A or B" without a wrapping
// "either"). Renders as a single block with a custom dropdown that lets
// the user pick which option the upstream subtree should expand. Width
// matches NODE_WIDTH in PrereqTree so column-layout x-coordinates stay
// valid.
//
// We don't use a native `<select>` here. Native dropdown popups are
// rendered by the OS outside the browser DOM, so they escape ReactFlow's
// CSS transform — the closed control scales with the canvas zoom but the
// open menu pops at native size. Building the menu as an absolutely-
// positioned <div> inside the node's transformed container lets it scale
// with the rest of the graph.

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
}

const HANDLE_STYLE = {
  opacity: 0,
  width: 8,
  height: 8,
  border: 'none',
  background: 'transparent',
  pointerEvents: 'none' as const,
}

export function DisjunctionNode({ data }: NodeProps<DisjunctionData>) {
  const { options, selectedIdx, onChange, detail } = data
  const detailKnown = detail?.kind === 'course' && detail.title !== null
  const detailUnknownCourse =
    detail?.kind === 'course' && detail.title === null
  // Match CourseNode's dim treatment for unknown-course detail (was
  // previously a red highlight, which incorrectly flagged externally-valid
  // prereqs like "CALC 12" as errors). Solid block stays for the dropdown
  // chrome itself; only the bg + border move to the dim palette.
  const bg = detailUnknownCourse ? 'var(--surface)' : 'var(--node-bg)'
  const border = detailUnknownCourse ? 'var(--fg-faint)' : 'var(--node-border)'
  return (
    <div
      style={{
        background: bg,
        border: `1px ${detailUnknownCourse ? 'dashed' : 'solid'} ${border}`,
        borderRadius: 6,
        padding: 6,
        width: 200,
        color: 'var(--fg)',
        fontSize: 11,
        textAlign: 'left',
      }}
    >
      {/* Invisible handles on all four sides so an edge can attach
          wherever the layout needs (prereq target / source on left/right,
          coreq target / source on top/bottom). Default targetHandle for
          edges that don't specify one falls through to left-target. */}
      <Handle type="target" id="left-target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle type="target" id="top-target" position={Position.Top} style={HANDLE_STYLE} />
      <DropdownSelect
        options={options}
        selectedIdx={selectedIdx}
        onChange={onChange}
        selectedIsUnknown={detailUnknownCourse}
      />
      {detail && (
        <div
          style={{
            marginTop: 6,
            paddingTop: 6,
            borderTop: '1px solid var(--node-border)',
            fontSize: 11,
            lineHeight: 1.3,
            color: detailKnown ? 'var(--fg)' : 'var(--fg-muted)',
            // Italicize for both literals and unknown-course detail so
            // their treatment matches the standalone CourseNode 'unknown'
            // and 'note' variants.
            fontStyle:
              detail.kind === 'literal' || detailUnknownCourse
                ? 'italic'
                : 'normal',
          }}
        >
          {detail.kind === 'course'
            ? (detail.title ?? '(not in calendar)')
            : renderTextWithLinks(detail.text)}
        </div>
      )}
      <Handle type="source" id="right-source" position={Position.Right} style={HANDLE_STYLE} />
      <Handle type="source" id="bottom-source" position={Position.Bottom} style={HANDLE_STYLE} />
    </div>
  )
}

// Zoom-friendly dropdown replacement for <select>. The trigger button is
// a regular DOM element; the open menu is an absolutely-positioned <div>
// inside the same transformed container as the node, so both inherit the
// canvas zoom. Click-outside / mousedown-outside dismisses; pointer
// events stop-propagating so they don't reach ReactFlow's pan/zoom
// handlers and start a drag.
function DropdownSelect({
  options,
  selectedIdx,
  onChange,
  selectedIsUnknown,
}: {
  options: DisjunctionOption[]
  selectedIdx: number
  onChange: (idx: number) => void
  selectedIsUnknown: boolean
}) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Click-outside-to-close. We listen for `pointerdown` (not `mousedown`)
  // in the capture phase so the handler fires before any other listener
  // can call preventDefault — ReactFlow's pane uses pointer events for
  // pan/zoom and on some browsers preventDefault on pointerdown
  // suppresses the synthesized mousedown, which is why a `mousedown`
  // listener missed the canvas click here. Capture phase also bypasses
  // the React root's event delegation so `e.stopPropagation()` calls on
  // child handlers can't kill the listener either.
  useEffect(() => {
    if (!open) return
    function handler(e: PointerEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [open])

  // Bump the parent `.react-flow__node` wrapper's z-index while the menu is
  // open. Each ReactFlow node has `transform: translate(...)`, which creates
  // a stacking context — so the menu's local z-index only orders elements
  // inside its own node. To paint over sibling nodes (the user-visible "menu
  // is clipped by the next course block" symptom) the wrapper itself has to
  // move forward in the sibling order.
  //
  // Why DOM and not ReactFlow's `setNodes`: in controlled mode (no
  // `defaultNodes`, no `onNodesChange` — which is how PrereqTree wires up
  // ReactFlow), `useReactFlow().setNodes` is a no-op. We bypass it and
  // mutate the wrapper's inline style directly.
  useEffect(() => {
    if (!open) return
    const nodeEl = wrapperRef.current?.closest(
      '.react-flow__node',
    ) as HTMLElement | null
    if (!nodeEl) return
    const prev = nodeEl.style.zIndex
    nodeEl.style.zIndex = '1000'
    return () => {
      nodeEl.style.zIndex = prev
    }
  }, [open])

  const current = options[selectedIdx]?.display ?? ''

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        // Stop propagation on both pointerdown (capture-phase document
        // listener fires before this, but stopping here keeps the canvas
        // pan handler from starting a drag) and mousedown (covers
        // browsers that haven't unified on pointer events).
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          // Only the open transition gets the chirp — closing happens
          // implicitly when the user picks an option (dropdownPick fires)
          // or clicks outside (no SFX needed), so playing on every toggle
          // would double-up with those flows.
          if (!open) playSfx('dropdownOpen')
          setOpen((o) => !o)
        }}
        style={{
          width: '100%',
          background: 'var(--input)',
          border: '1px solid var(--line-soft)',
          color: 'var(--fg)',
          padding: '3px 4px',
          borderRadius: 4,
          fontSize: 11,
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 4,
          fontFamily: 'inherit',
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            // Bold the chosen option so the dropdown's selected course
            // reads with the same weight as a regular CourseNode's code
            // line. The open-menu options below stay at default weight
            // so they read as picker choices, not headers. Unknown
            // courses (not in the calendar) drop the bold to match the
            // dim/italic treatment of the standalone CourseNode 'unknown'
            // variant.
            fontWeight: selectedIsUnknown ? 'normal' : 600,
          }}
        >
          {current}
        </span>
        <span style={{ color: 'var(--fg-faint)', fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <div
          // `nowheel` is ReactFlow's built-in opt-out for wheel handling on
          // a descendant — without it the menu's `overflowY: auto` never
          // gets to consume the wheel event because ReactFlow's pane
          // listener at the canvas level fires first and turns it into a
          // zoom. With the class set, ReactFlow ignores wheels that
          // originate inside this element.
          className="nowheel"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 2,
            background: 'var(--input)',
            border: '1px solid var(--fg-faint)',
            borderRadius: 4,
            // High z-index so the menu paints over adjacent / next-row
            // nodes that the menu might extend into vertically. ReactFlow
            // node wrappers don't set explicit z-index by default, so 1000
            // is enough to win the stacking race within this node's
            // siblings.
            zIndex: 1000,
            maxHeight: 240,
            overflowY: 'auto',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          }}
        >
          {options.map((opt, i) => {
            const isSelected = i === selectedIdx
            return (
              <div
                key={i}
                onClick={(e) => {
                  e.stopPropagation()
                  onChange(i)
                  setOpen(false)
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) {
                    ;(e.currentTarget as HTMLDivElement).style.background =
                      'var(--surface)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    ;(e.currentTarget as HTMLDivElement).style.background =
                      'transparent'
                  }
                }}
                style={{
                  padding: '4px 6px',
                  fontSize: 11,
                  lineHeight: 1.3,
                  color: 'var(--fg)',
                  background: isSelected ? 'var(--surface-raised)' : 'transparent',
                  cursor: 'pointer',
                  whiteSpace: 'normal',
                }}
              >
                {opt.display}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
