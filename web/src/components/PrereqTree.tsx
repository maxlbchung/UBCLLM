import { useEffect, useMemo, useState } from 'react'
import ReactFlow, {
  Background,
  Controls,
  Position,
  type Edge,
  type Node,
} from 'reactflow'
import 'reactflow/dist/style.css'
import {
  extractCourseCodes,
  getCourseIndex,
  parseCourseChunk,
  type Chunk,
  type ParsedCourse,
} from '../lib/retrieve'

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

interface Info {
  code: string
  parsed: ParsedCourse | null
  depth: number
  kind: 'root' | 'prereq' | 'coreq'
}

const MAX_DEPTH = 12 // safety cap; UBC chains rarely exceed 4–5

const X_STEP = 280
const Y_STEP = 90

function buildGraph(rootCode: string, index: Map<string, Chunk>): Graph {
  const rootChunk = index.get(rootCode)
  if (!rootChunk) return { nodes: [], edges: [], depthCount: 0 }
  const root = parseCourseChunk(rootChunk)

  // BFS over prereq edges, deduping nodes and keeping every node at its first
  // (shortest) discovered depth. Edges still get added every time we see them
  // so a course required by multiple ancestors connects to all of them.
  const infoByCode = new Map<string, Info>()
  infoByCode.set(rootCode, { code: rootCode, parsed: root, depth: 0, kind: 'root' })
  const edges: Edge[] = []
  const enqueued = new Set<string>([rootCode])

  type QItem = { code: string; parsed: ParsedCourse; depth: number }
  const queue: QItem[] = [{ code: rootCode, parsed: root, depth: 0 }]

  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur.depth >= MAX_DEPTH) continue
    const prereqCodes = extractCourseCodes(cur.parsed.prerequisites)
    for (const code of prereqCodes) {
      if (code === cur.code) continue
      edges.push({
        id: `prereq:${code}->${cur.code}`,
        source: code,
        target: cur.code,
        style: { stroke: '#52525b', strokeWidth: 1.5 },
      })
      if (enqueued.has(code)) continue
      enqueued.add(code)
      const chunk = index.get(code)
      const parsed = chunk ? parseCourseChunk(chunk) : null
      const childDepth = cur.depth + 1
      infoByCode.set(code, { code, parsed, depth: childDepth, kind: 'prereq' })
      if (parsed) queue.push({ code, parsed, depth: childDepth })
    }
  }

  // Direct corequisites of the root only (not transitively expanded — coreqs
  // are taken alongside, not "before", so adding their prereq trees is noisy).
  for (const code of extractCourseCodes(root.corequisites)) {
    if (code === rootCode || infoByCode.has(code)) continue
    const chunk = index.get(code)
    const parsed = chunk ? parseCourseChunk(chunk) : null
    infoByCode.set(code, { code, parsed, depth: 0, kind: 'coreq' })
    edges.push({
      id: `coreq:${code}->${rootCode}`,
      source: code,
      target: rootCode,
      label: 'co-req',
      style: { stroke: '#f59e0b', strokeWidth: 1.5 },
      labelStyle: { fill: '#f59e0b', fontSize: 10 },
    })
  }

  // Column layout: root at x=0, transitive prereqs in columns to the left
  // (one column per depth), direct coreqs in a column to the right.
  const byColumn = new Map<string, Info[]>()
  let depthCount = 0
  for (const info of infoByCode.values()) {
    const key = info.kind === 'coreq' ? 'coreq' : `d${info.depth}`
    if (!byColumn.has(key)) byColumn.set(key, [])
    byColumn.get(key)!.push(info)
    if (info.kind !== 'coreq') depthCount = Math.max(depthCount, info.depth)
  }

  const nodes: Node[] = []
  for (const [key, infos] of byColumn) {
    const isCoreq = key === 'coreq'
    const depth = isCoreq ? 0 : Number(key.slice(1))
    const x = isCoreq ? X_STEP : -depth * X_STEP
    infos.sort((a, b) => a.code.localeCompare(b.code))
    const total = infos.length
    infos.forEach((info, i) => {
      const y = (i - (total - 1) / 2) * Y_STEP
      const known = info.parsed !== null
      const isRoot = info.kind === 'root'
      const title = info.parsed?.title ?? '(not in calendar)'

      const bg = isRoot
        ? '#1d4ed8'
        : known
          ? '#27272a'
          : '#3f1d1d'
      const border = isRoot
        ? '#1e40af'
        : known
          ? '#3f3f46'
          : '#7f1d1d'

      nodes.push({
        id: info.code,
        position: { x, y },
        data: { label: `${info.code}\n${title}` },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: bg,
          color: isRoot ? '#fff' : '#e5e7eb',
          border: `1px solid ${border}`,
          fontSize: isRoot ? 12 : 11,
          whiteSpace: 'pre-line',
          padding: isRoot ? 8 : 6,
          borderRadius: 6,
          width: 200,
        },
      })
    })
  }

  return { nodes, edges, depthCount }
}

export function PrereqTree() {
  const [index, setIndex] = useState<Map<string, Chunk> | null>(null)
  const [query, setQuery] = useState('CPSC 121')
  const [activeCode, setActiveCode] = useState<string | null>('CPSC 121')

  useEffect(() => {
    void getCourseIndex().then(setIndex)
  }, [])

  const graph = useMemo(() => {
    if (!index || !activeCode) return { nodes: [], edges: [], depthCount: 0 }
    return buildGraph(activeCode, index)
  }, [index, activeCode])

  const root = useMemo(() => {
    if (!index || !activeCode) return null
    const chunk = index.get(activeCode)
    return chunk ? parseCourseChunk(chunk) : null
  }, [index, activeCode])

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
          full transitive chain · regex-extracted course codes
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
              {' '}— {graph.nodes.length - 1} courses across {graph.depthCount}{' '}
              {graph.depthCount === 1 ? 'level' : 'levels'}
            </>
          )}
          . Direct corequisites appear on the right (not transitively expanded).
          Boolean structure ("all of", "one of", grade thresholds) is preserved
          as text in the chat view, not in this graph.
        </p>
      )}

      <div className="flex-1 rounded border border-zinc-800 bg-zinc-950">
        {graph.nodes.length > 0 ? (
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            nodesDraggable={false}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#27272a" gap={16} />
            <Controls showInteractive={false} />
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
