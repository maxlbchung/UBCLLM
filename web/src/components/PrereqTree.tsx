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
} from '../lib/retrieve'

function normalize(query: string): string {
  const m = query.toUpperCase().match(/^([A-Z]{2,5})(?:_V)?\s*(\d{2,4}[A-Z]?)$/)
  if (!m) return query.toUpperCase().replace(/\s+/g, ' ').trim()
  return `${m[1]} ${m[2]}`
}

interface Graph {
  nodes: Node[]
  edges: Edge[]
}

function buildGraph(rootCode: string, index: Map<string, Chunk>): Graph {
  const rootChunk = index.get(rootCode)
  if (!rootChunk) return { nodes: [], edges: [] }
  const root = parseCourseChunk(rootChunk)
  const prereqCodes = extractCourseCodes(root.prerequisites).filter(
    (c) => c !== rootCode,
  )
  const coreqCodes = extractCourseCodes(root.corequisites).filter(
    (c) => c !== rootCode,
  )

  const nodes: Node[] = []
  const edges: Edge[] = []

  nodes.push({
    id: rootCode,
    position: { x: 0, y: 0 },
    data: { label: `${rootCode}\n${root.title}` },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    style: {
      background: '#1d4ed8',
      color: '#fff',
      border: '1px solid #1e40af',
      fontSize: 12,
      whiteSpace: 'pre-line',
      padding: 8,
      borderRadius: 6,
      width: 200,
    },
  })

  const place = (codes: string[], xOffset: number, kind: 'prereq' | 'coreq') => {
    const total = codes.length
    codes.forEach((code, i) => {
      const known = index.has(code)
      const chunk = known ? index.get(code)! : null
      const title = chunk ? parseCourseChunk(chunk).title : '(not in calendar)'
      const y = (i - (total - 1) / 2) * 90
      nodes.push({
        id: `${kind}:${code}`,
        position: { x: xOffset, y },
        data: { label: `${code}\n${title}` },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: known ? '#27272a' : '#3f1d1d',
          color: '#e5e7eb',
          border: `1px solid ${known ? '#3f3f46' : '#7f1d1d'}`,
          fontSize: 11,
          whiteSpace: 'pre-line',
          padding: 6,
          borderRadius: 6,
          width: 200,
        },
      })
      edges.push({
        id: `${kind}:${code}->${rootCode}`,
        source: `${kind}:${code}`,
        target: rootCode,
        animated: false,
        label: kind === 'coreq' ? 'co-req' : undefined,
        style: {
          stroke: kind === 'coreq' ? '#f59e0b' : '#52525b',
          strokeWidth: 1.5,
        },
        labelStyle: { fill: '#f59e0b', fontSize: 10 },
      })
    })
  }

  place(prereqCodes, -340, 'prereq')
  place(coreqCodes, 340, 'coreq')

  return { nodes, edges }
}

export function PrereqTree() {
  const [index, setIndex] = useState<Map<string, Chunk> | null>(null)
  const [query, setQuery] = useState('CPSC 121')
  const [activeCode, setActiveCode] = useState<string | null>('CPSC 121')

  useEffect(() => {
    void getCourseIndex().then(setIndex)
  }, [])

  const graph = useMemo(() => {
    if (!index || !activeCode) return { nodes: [], edges: [] }
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
          v1: one level, regex-extracted course codes
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
          Showing direct prerequisites and corequisites for{' '}
          <span className="text-zinc-200">{root.code}</span>. Boolean structure
          (e.g. "all of", "one of", grade thresholds) is preserved as text in
          the chat view, not in this graph.
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
