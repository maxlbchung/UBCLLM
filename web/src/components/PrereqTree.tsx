import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactFlow, {
  Background,
  Controls,
  Position,
  useReactFlow,
  type Edge,
  type Node,
} from 'reactflow'
import 'reactflow/dist/style.css'
import {
  getCourseIndex,
  parseCourseChunk,
  type Chunk,
  type ParsedCourse,
} from '../lib/retrieve'
import {
  displayExpr,
  parsePrereq,
  type Expr,
} from '../lib/prereqAst'
import {
  DisjunctionNode,
  type DisjunctionData,
  type DisjunctionDetail,
} from './DisjunctionNode'
import { EitherOrNode, type EitherOrData } from './EitherOrNode'
import { CourseNode } from './CourseNode'

function normalize(query: string): string {
  const m = query.toUpperCase().match(/^([A-Z]{2,5})(?:_V)?\s*(\d{2,4}[A-Z]?)$/)
  if (!m) return query.toUpperCase().replace(/\s+/g, ' ').trim()
  return `${m[1]} ${m[2]}`
}

interface Graph {
  nodes: Node[]
  edges: Edge[]
  depthCount: number
}

// Per-column items. `course` is a real course (or unknown course referenced
// in some other course's prereqs); `group` is a disjunction / either-or
// block that wraps a sub-expression and only expands its currently-selected
// child to the left.
type ColumnItem =
  | {
      kind: 'course'
      id: string
      code: string
      parsed: ParsedCourse | null
      role: 'root' | 'prereq' | 'coreq'
    }
  | {
      kind: 'group'
      id: string
      ui: 'dropdown' | 'stacked'
      optionCount: number
      data: DisjunctionData | EitherOrData
    }

const MAX_DEPTH = 12 // safety cap; UBC chains rarely exceed 4–5

const X_STEP = 280
const Y_STEP = 90 // minimum vertical slot per item — wider groups grow past this
const Y_GAP = 20 // additional gap between items when a tall item bumps the slot
const NODE_WIDTH = 200
const COURSE_HEIGHT = 50
const DISJUNCTION_HEIGHT = 70
const DISJUNCTION_HEIGHT_WITH_DETAIL = 110
const EITHEROR_HEADER = 30
const EITHEROR_ROW = 36

function heightOf(item: ColumnItem): number {
  if (item.kind === 'course') return COURSE_HEIGHT
  if (item.ui === 'dropdown') {
    const data = item.data as DisjunctionData
    return data.detail ? DISJUNCTION_HEIGHT_WITH_DETAIL : DISJUNCTION_HEIGHT
  }
  return EITHEROR_HEADER + item.optionCount * EITHEROR_ROW
}

function buildGraph(
  rootCode: string,
  index: Map<string, Chunk>,
  selections: Map<string, number>,
  setSelection: (key: string, idx: number) => void,
): Graph {
  const rootChunk = index.get(rootCode)
  if (!rootChunk) return { nodes: [], edges: [], depthCount: 0 }
  const root = parseCourseChunk(rootChunk)

  // BFS over courses we've decided to expand. Nodes (course or group) live
  // in `byId`, edges accumulate flat. `enqueued` is keyed by canonical
  // course code; first-seen-depth wins (existing behavior). Group nodes
  // dedup naturally because their ids are derived from a stable
  // `${ownerCode}::${path}` selection key. `coreqIds` tracks which ids
  // belong on the coreq side so the layout pass can put them in the
  // right column without us hanging extra fields off the union type.
  const byId = new Map<string, ColumnItem & { depth: number }>()
  byId.set(rootCode, {
    kind: 'course',
    id: rootCode,
    code: rootCode,
    parsed: root,
    role: 'root',
    depth: 0,
  })
  const edges: Edge[] = []
  const enqueued = new Set<string>([rootCode])
  const coreqIds = new Set<string>()
  // When a dropdown's chosen option is a course code, the dropdown block
  // *is* that course in the graph — no separate course node trails it. We
  // record the absorption here so that any *other* path that would have
  // pointed an edge at the absorbed course code instead points at the
  // dropdown's group id.
  const codeAliases = new Map<string, string>()

  type QItem = { code: string; parsed: ParsedCourse; depth: number }
  const queue: QItem[] = [{ code: rootCode, parsed: root, depth: 0 }]

  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur.depth >= MAX_DEPTH) continue
    const ast = parsePrereq(cur.parsed.prerequisites)
    if (!ast) continue
    walkAst(ast, cur.code, cur.depth + 1, '', cur.code)
  }

  // Direct corequisites of the root only (not transitively expanded — coreqs
  // are taken alongside, not "before", so adding their prereq trees is
  // noisy). Same AST treatment as prereqs, just we don't queue any course
  // we discover under the coreq tree.
  const coreqAst = parsePrereq(root.corequisites)
  if (coreqAst) {
    walkAst(coreqAst, rootCode, 0, 'coreq', rootCode, /*isCoreq*/ true)
  }

  function walkAst(
    expr: Expr,
    ownerCode: string,
    depth: number,
    path: string,
    targetId: string,
    isCoreq = false,
  ): void {
    if (depth > MAX_DEPTH) return
    switch (expr.kind) {
      case 'and':
        expr.children.forEach((child, i) =>
          walkAst(child, ownerCode, depth, `${path}.and[${i}]`, targetId, isCoreq),
        )
        return
      case 'or': {
        const key = `${ownerCode}::${path}.or`
        const groupId = `grp:${key}`
        const chosen = selections.get(key) ?? 0
        const safeChosen = Math.max(0, Math.min(chosen, expr.children.length - 1))
        const chosenExpr = expr.children[safeChosen]

        // Resolve the dropdown's "selected detail" — what gets rendered
        // under the <select>. Dropdown variant absorbs the selected
        // course's identity so there's no trailing course node; the
        // either-or stacked variant doesn't absorb (each radio sub-block
        // already shows the option label inline).
        let dropdownDetail: DisjunctionDetail = null
        if (expr.ui === 'dropdown' && chosenExpr) {
          if (chosenExpr.kind === 'code') {
            const absorbedChunk = index.get(chosenExpr.code)
            const absorbedParsed = absorbedChunk
              ? parseCourseChunk(absorbedChunk)
              : null
            dropdownDetail = {
              kind: 'course',
              code: chosenExpr.code,
              title: absorbedParsed?.title ?? null,
            }
            // Mark the absorbed code so any other path that names it as a
            // prereq points at this group instead of materializing a
            // duplicate course node.
            codeAliases.set(chosenExpr.code, groupId)
            enqueued.add(chosenExpr.code)
          } else if (chosenExpr.kind === 'literal') {
            dropdownDetail = { kind: 'literal', text: chosenExpr.text }
          }
        }

        registerGroup(groupId, key, expr, safeChosen, depth, isCoreq, dropdownDetail)
        edges.push({
          id: `${isCoreq ? 'coreq' : 'prereq'}:${groupId}->${targetId}`,
          source: groupId,
          target: targetId,
          ...(targetId === rootCode
            ? { targetHandle: isCoreq ? 'top-target' : 'left-target' }
            : {}),
          ...(isCoreq
            ? {
                label: 'co-req',
                style: { stroke: '#f59e0b', strokeWidth: 1.5 },
                labelStyle: { fill: '#f59e0b', fontSize: 10 },
              }
            : { style: { stroke: '#52525b', strokeWidth: 1.5 } }),
        })

        if (!chosenExpr) return

        // Dropdown + course → dropdown IS the course; absorb. For prereqs,
        // walk the absorbed course's own prereqs inline with target =
        // groupId. For coreqs the dropdown is also the course (no trailing
        // node), but coreqs aren't transitive so there's nothing to walk.
        if (expr.ui === 'dropdown' && chosenExpr.kind === 'code') {
          if (!isCoreq) {
            const absorbedChunk = index.get(chosenExpr.code)
            const absorbedParsed = absorbedChunk
              ? parseCourseChunk(absorbedChunk)
              : null
            if (absorbedParsed && depth + 1 <= MAX_DEPTH) {
              const absorbedAst = parsePrereq(absorbedParsed.prerequisites)
              if (absorbedAst) {
                walkAst(absorbedAst, chosenExpr.code, depth + 1, '', groupId)
              }
            }
          }
          return
        }

        // Dropdown + literal: detail already shown under the dropdown,
        // nothing to expand.
        if (expr.ui === 'dropdown' && chosenExpr.kind === 'literal') return

        // Either-or stacked, or dropdown with a nested chosen expression:
        // fall through to the existing "edges target groupId" walk.
        if (isCoreq) {
          if (chosenExpr.kind === 'code') {
            attachCoreqCode(chosenExpr.code, groupId)
          } else if (chosenExpr.kind === 'and' || chosenExpr.kind === 'or') {
            walkAst(
              chosenExpr,
              ownerCode,
              depth + 1,
              `${path}.or[${safeChosen}]`,
              groupId,
              true,
            )
          }
          return
        }
        if (chosenExpr.kind === 'code') {
          attachPrereqCode(chosenExpr.code, depth + 1, groupId)
        } else if (
          chosenExpr.kind === 'and' ||
          chosenExpr.kind === 'or'
        ) {
          walkAst(
            chosenExpr,
            ownerCode,
            depth + 1,
            `${path}.or[${safeChosen}]`,
            groupId,
          )
        }
        // literal in stacked: terminates. The radio's text is the only
        // display.
        return
      }
      case 'code':
        if (isCoreq) attachCoreqCode(expr.code, targetId)
        else attachPrereqCode(expr.code, depth, targetId)
        return
      case 'literal':
        // Top-level literals carry no graph signal. Already preserved as
        // text in the chat view.
        return
    }
  }

  function attachPrereqCode(code: string, depth: number, targetId: string): void {
    // Resolve through codeAliases so that if `code` has been absorbed into
    // a dropdown elsewhere, this edge points at that dropdown's group id
    // (not a phantom course node that doesn't exist).
    const sourceId = codeAliases.get(code) ?? code
    if (sourceId === targetId) return
    edges.push({
      id: `prereq:${sourceId}->${targetId}`,
      source: sourceId,
      target: targetId,
      // Root is a custom CourseNode with multiple target handles; aim
      // prereq edges at its left handle so they don't fight the coreq
      // chain landing on the top.
      ...(targetId === rootCode ? { targetHandle: 'left-target' } : {}),
      style: { stroke: '#52525b', strokeWidth: 1.5 },
    })
    if (codeAliases.has(code)) return
    if (enqueued.has(code)) return
    enqueued.add(code)
    const chunk = index.get(code)
    const parsed = chunk ? parseCourseChunk(chunk) : null
    byId.set(code, {
      kind: 'course',
      id: code,
      code,
      parsed,
      role: 'prereq',
      depth,
    })
    if (parsed) queue.push({ code, parsed, depth })
  }

  function attachCoreqCode(code: string, targetId: string): void {
    const sourceId = codeAliases.get(code) ?? code
    if (sourceId === targetId) return
    edges.push({
      id: `coreq:${sourceId}->${targetId}`,
      source: sourceId,
      target: targetId,
      ...(targetId === rootCode ? { targetHandle: 'top-target' } : {}),
      label: 'co-req',
      style: { stroke: '#f59e0b', strokeWidth: 1.5 },
      labelStyle: { fill: '#f59e0b', fontSize: 10 },
    })
    if (codeAliases.has(code)) return
    if (enqueued.has(code)) return
    enqueued.add(code)
    coreqIds.add(code)
    const chunk = index.get(code)
    const parsed = chunk ? parseCourseChunk(chunk) : null
    byId.set(code, {
      kind: 'course',
      id: code,
      code,
      parsed,
      role: 'coreq',
      depth: 0,
    })
    // Note: no queue.push — coreqs don't expand transitively.
  }

  function registerGroup(
    groupId: string,
    key: string,
    expr: Expr & { kind: 'or' },
    selectedIdx: number,
    depth: number,
    isCoreq: boolean,
    detail: DisjunctionDetail,
  ): void {
    if (isCoreq) coreqIds.add(groupId)
    if (byId.has(groupId)) return
    const onChange = (idx: number) => setSelection(key, idx)
    if (expr.ui === 'dropdown') {
      const data: DisjunctionData = {
        options: expr.children.map((child) => ({
          display: displayExpr(child),
          isCode: child.kind === 'code',
        })),
        selectedIdx,
        onChange,
        detail,
      }
      byId.set(groupId, {
        kind: 'group',
        id: groupId,
        ui: 'dropdown',
        optionCount: expr.children.length,
        data,
        depth: isCoreq ? 0 : depth,
      })
    } else {
      const data: EitherOrData = {
        options: expr.children.map((child, i) => ({
          label: String.fromCharCode('a'.charCodeAt(0) + i),
          display: displayExpr(child),
        })),
        selectedIdx,
        onChange,
      }
      byId.set(groupId, {
        kind: 'group',
        id: groupId,
        ui: 'stacked',
        optionCount: expr.children.length,
        data,
        depth: isCoreq ? 0 : depth,
      })
    }
  }

  // ---------- Layout ----------
  // Group items by column (depth for prereq side, 'coreq' for the right side).
  // Within a column, sort courses alphabetically and append groups
  // deterministically. Stack vertically with a per-item slot height that
  // grows past Y_STEP for tall either-or groups.
  type Placed = ColumnItem & { depth: number }
  const byColumn = new Map<string, Placed[]>()
  let depthCount = 0
  for (const placed of byId.values()) {
    const isCoreq =
      coreqIds.has(placed.id) ||
      (placed.kind === 'course' && placed.role === 'coreq')
    const colKey = isCoreq ? 'coreq' : `d${placed.depth}`
    if (!byColumn.has(colKey)) byColumn.set(colKey, [])
    byColumn.get(colKey)!.push(placed)
    if (!isCoreq && placed.kind === 'course') {
      depthCount = Math.max(depthCount, placed.depth)
    }
  }

  const nodes: Node[] = []
  // Track top-level coreq item ids in vertical order so we can rewrite
  // their edges into a chain after layout: the topmost coreq's bottom
  // handle connects to the next coreq's top handle, on down to the
  // bottommost coreq, whose edge still terminates at the root.
  const coreqChain: string[] = []

  for (const [colKey, items] of byColumn) {
    const isCoreqCol = colKey === 'coreq'
    items.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'course' ? -1 : 1
      if (a.kind === 'course' && b.kind === 'course') {
        return a.code.localeCompare(b.code)
      }
      return a.id.localeCompare(b.id)
    })

    if (isCoreqCol) {
      // Coreq column sits in the same x as the root, stacked directly
      // above it. Items closer to root in the array end up closer to root
      // visually; we iterate bottom-up so the bottommost item lands just
      // above the root with one Y_GAP of space, and each item above sits
      // its own height + Y_GAP further up.
      const x = 0
      let nextBottomY = -COURSE_HEIGHT / 2 - Y_GAP // bottom edge of the next item to place
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        const h = heightOf(item)
        const positionY = nextBottomY - h
        if (item.kind === 'course') {
          const known = item.parsed !== null
          const title = item.parsed?.title ?? '(not in calendar)'
          const bg = known ? '#27272a' : '#3f1d1d'
          const border = known ? '#3f3f46' : '#7f1d1d'
          nodes.push({
            id: item.id,
            position: { x, y: positionY },
            data: { label: `${item.code}\n${title}` },
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            style: {
              background: bg,
              color: '#e5e7eb',
              border: `1px solid ${border}`,
              fontSize: 11,
              whiteSpace: 'pre-line',
              padding: 6,
              borderRadius: 6,
              width: NODE_WIDTH,
            },
          })
        } else {
          // Group node — pass orientation through `data` so the custom
          // node renders its handles on top + bottom.
          const verticalData = { ...item.data, orientation: 'vertical' as const }
          nodes.push({
            id: item.id,
            type: item.ui === 'stacked' ? 'eitherOr' : 'disjunction',
            position: { x, y: positionY },
            data: verticalData,
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            style: { width: NODE_WIDTH },
          })
        }
        nextBottomY = positionY - Y_GAP
      }
      // Record the chain in top-to-bottom order.
      for (const it of items) coreqChain.push(it.id)
      continue
    }

    const depth = Number(colKey.slice(1))
    const x = -depth * X_STEP
    const slotHeights = items.map((item) =>
      Math.max(heightOf(item), Y_STEP),
    )
    const totalHeight =
      slotHeights.reduce((a, b) => a + b, 0) +
      Math.max(0, items.length - 1) * Y_GAP
    let cursor = -totalHeight / 2
    items.forEach((item, i) => {
      const slot = slotHeights[i]
      const yCenter = cursor + slot / 2
      cursor += slot + (i < items.length - 1 ? Y_GAP : 0)

      if (item.kind === 'course') {
        const known = item.parsed !== null
        const isRoot = item.role === 'root'
        const title = item.parsed?.title ?? '(not in calendar)'
        if (isRoot) {
          // Custom node so the coreq chain can land on a top handle while
          // prereqs continue to land on the left.
          nodes.push({
            id: item.id,
            type: 'course',
            position: { x, y: yCenter - COURSE_HEIGHT / 2 },
            data: { label: `${item.code}\n${title}`, isRoot: true, known },
          })
        } else {
          const bg = known ? '#27272a' : '#3f1d1d'
          const border = known ? '#3f3f46' : '#7f1d1d'
          nodes.push({
            id: item.id,
            position: { x, y: yCenter - COURSE_HEIGHT / 2 },
            data: { label: `${item.code}\n${title}` },
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
            style: {
              background: bg,
              color: '#e5e7eb',
              border: `1px solid ${border}`,
              fontSize: 11,
              whiteSpace: 'pre-line',
              padding: 6,
              borderRadius: 6,
              width: NODE_WIDTH,
            },
          })
        }
      } else {
        const h = heightOf(item)
        nodes.push({
          id: item.id,
          type: item.ui === 'stacked' ? 'eitherOr' : 'disjunction',
          position: { x, y: yCenter - h / 2 },
          data: item.data,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          style: { width: NODE_WIDTH },
        })
      }
    })
  }

  // Rewrite top-level coreq edges (everything in the coreq column with
  // target = root) into a chain. With items in top-to-bottom order, each
  // item's edge points at the next item below it; the bottommost still
  // points at the root.
  if (coreqChain.length > 0) {
    const targetById = new Map<string, string>()
    for (let i = 0; i < coreqChain.length; i++) {
      targetById.set(
        coreqChain[i],
        i < coreqChain.length - 1 ? coreqChain[i + 1] : rootCode,
      )
    }
    for (const edge of edges) {
      if (
        edge.target === rootCode &&
        typeof edge.id === 'string' &&
        edge.id.startsWith('coreq:') &&
        targetById.has(edge.source)
      ) {
        const newTarget = targetById.get(edge.source)!
        edge.target = newTarget
        edge.id = `coreq:${edge.source}->${newTarget}`
        // Targeting another coreq (default node, single target handle)
        // → drop the explicit handle id so ReactFlow uses the implicit
        // top handle. Targeting root (custom node) → keep top-target so
        // it lands on the top handle, not the left one.
        if (newTarget === rootCode) {
          edge.targetHandle = 'top-target'
        } else {
          delete edge.targetHandle
        }
      }
    }
  }

  return { nodes, edges, depthCount }
}

// Horizontal-only auto-fit. ReactFlow's built-in `fitView` fits both axes,
// so a tall narrow tree leaves big horizontal margins because the vertical
// extent becomes the limiting factor. Spec: leftmost and rightmost blocks
// stay in view at all times, even if that means the chart overflows
// vertically and the user pans to reach lower courses. We feed `fitBounds`
// a bbox with the chart's true horizontal extent and a 1-pixel height so
// the horizontal axis always wins the zoom calculation.
function HorizontalFitOnChange({
  nodes,
  fitKey,
}: {
  nodes: Node[]
  fitKey: string
}) {
  const { fitBounds } = useReactFlow()
  useEffect(() => {
    if (nodes.length === 0) return
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const n of nodes) {
      const x = n.position.x
      const y = n.position.y
      if (x < minX) minX = x
      if (x + NODE_WIDTH > maxX) maxX = x + NODE_WIDTH
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    fitBounds(
      {
        x: minX,
        y: (minY + maxY) / 2,
        width: maxX - minX,
        height: 1,
      },
      { padding: 0.05, duration: 200 },
    )
  }, [nodes, fitKey, fitBounds])
  return null
}

const NODE_TYPES = {
  disjunction: DisjunctionNode,
  eitherOr: EitherOrNode,
  course: CourseNode,
} as const

export function PrereqTree() {
  const [index, setIndex] = useState<Map<string, Chunk> | null>(null)
  const [query, setQuery] = useState('CPSC 121')
  const [activeCode, setActiveCode] = useState<string | null>('CPSC 121')
  // Per-disjunction selection map. Keys are `${ownerCourseCode}::${path}`
  // — stable across re-renders so toggling one selection doesn't disturb
  // unrelated ones. Defaults are option 0 when a key is absent, so the
  // initial render always shows a fully-populated tree. Survives root-
  // course switches.
  const [selections, setSelections] = useState<Map<string, number>>(
    () => new Map(),
  )

  const setSelection = useCallback((key: string, idx: number) => {
    setSelections((prev) => {
      const next = new Map(prev)
      next.set(key, idx)
      return next
    })
  }, [])

  useEffect(() => {
    void getCourseIndex().then(setIndex)
  }, [])

  const graph = useMemo(() => {
    if (!index || !activeCode) return { nodes: [], edges: [], depthCount: 0 }
    return buildGraph(activeCode, index, selections, setSelection)
  }, [index, activeCode, selections, setSelection])

  const root = useMemo(() => {
    if (!index || !activeCode) return null
    const chunk = index.get(activeCode)
    return chunk ? parseCourseChunk(chunk) : null
  }, [index, activeCode])

  // Hash the selections map into the fitKey so the view re-fits after a
  // dropdown / radio change (column heights can shift when an either-or
  // group's selected branch swaps a tall sub-tree in/out).
  const selectionsKey = useMemo(
    () =>
      [...selections.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join('|'),
    [selections],
  )

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!index) return
    const code = normalize(query)
    if (index.has(code)) setActiveCode(code)
    else setActiveCode(null)
  }

  return (
    <div className="flex flex-col h-screen p-4 gap-3 w-full">
      <header className="flex items-center gap-3">
        <h2 className="text-xl font-semibold">Prerequisite Tree</h2>
        <span className="text-xs text-zinc-500">
          full transitive chain · boolean structure modeled
        </span>
      </header>

      <form onSubmit={submit} className="flex gap-2 max-w-md">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. CPSC 320"
          className="flex-1 rounded bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
        />
        <button
          type="submit"
          className="rounded bg-blue-600 hover:bg-blue-500 px-3 py-2 text-sm"
        >
          Show
        </button>
      </form>

      {!index && <p className="text-zinc-500">Loading course index…</p>}

      {index && !activeCode && (
        <p className="text-sm text-red-400">
          No course found. Try a code like CPSC 110 or MATH 200.
        </p>
      )}

      {root && (
        <p className="text-xs text-zinc-400">
          Showing every transitive prerequisite of{' '}
          <span className="text-zinc-200">{root.code}</span>
          {graph.nodes.length > 0 && (
            <>
              {' '}— {graph.nodes.length - 1} blocks across {graph.depthCount}{' '}
              {graph.depthCount === 1 ? 'level' : 'levels'}
            </>
          )}
          . "One of …" groups expose a dropdown; "Either (a) … or (b) …"
          groups stack their options with a radio selector. Direct
          corequisites appear on the right (not transitively expanded).
        </p>
      )}

      <div className="flex-1 rounded border border-zinc-800 bg-zinc-950">
        {graph.nodes.length > 0 ? (
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={NODE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#27272a" gap={16} />
            <Controls showInteractive={false} />
            <HorizontalFitOnChange
              nodes={graph.nodes}
              fitKey={`${activeCode ?? ''}::${selectionsKey}`}
            />
          </ReactFlow>
        ) : (
          <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
            Enter a course code to render its prerequisite graph.
          </div>
        )}
      </div>

      {root && !root.prerequisites && !root.corequisites && (
        <p className="text-sm text-zinc-400">
          {root.code} has no prerequisites or corequisites listed in the calendar.
        </p>
      )}
    </div>
  )
}
