import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, {
  Background,
  Controls,
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
import { CourseNode, type CourseNodeVariant } from './CourseNode'
import { SoftEdge, type SoftEdgeData } from './SoftEdge'
import { useConversations } from '../store/conversations'
import {
  LONGEST_PREREQ_TREE_EASTER_ID,
  useEasterEggs,
} from '../store/easterEggs'
import { playSfx } from '../lib/sfx'

// The corpus's deepest-possible prereq chain: FNH 483 has 15 nodes from
// CHEM 12 → … → FNH 483. With root at depth 0 the longest visible depth
// column is 14, so the easter only fires when the BFS reaches that floor
// (i.e. MAX_DEPTH didn't truncate the trail). See `longest_prereq.py` in
// the repo root for the offline computation that picks the winner.
const LONGEST_TREE_ROOT_CODE = 'FNH 483'
const LONGEST_TREE_DEPTH_COLUMN = 14

// Matches the bare "none" placeholder the chunker writes when prereqs /
// coreqs are absent (see `parsePrereq` for the parser-side counterpart).
// Used by the "no prerequisites or corequisites listed" footer message so
// it fires for both literally-empty values and the explicit "None" marker.
function isNoneOrEmpty(value: string | undefined): boolean {
  if (!value) return true
  return /^\s*none\s*\.?\s*$/i.test(value)
}

function normalize(query: string): string {
  const m = query.toUpperCase().match(/^([A-Z]{2,4})(?:_V)?\s*(\d{2,4}[A-Z]?)$/)
  if (!m) return query.toUpperCase().replace(/\s+/g, ' ').trim()
  return `${m[1]} ${m[2]}`
}

interface Graph {
  nodes: Node[]
  edges: Edge[]
  depthCount: number
  // True when the rendered tree is the corpus's deepest possible chain
  // (FNH 483 with its full 15-node CHEM-12-rooted ladder). Drives the gold
  // root tint + the easter-egg discovery counter.
  isLongestEaster: boolean
  // True top/left/bottom/right of the placed nodes in layout space. Tracks
  // each node's full vertical extent (top + estimated height), unlike a
  // bbox derived from `position.y` alone, which only sees top edges and
  // would push the auto-fit camera upward by half the bottommost node's
  // height. Null when no nodes were placed.
  bbox: { minX: number; maxX: number; minY: number; maxY: number } | null
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
      role: 'root' | 'prereq' | 'coreq' | 'note'
      // True when this node only appears in the graph because of a
      // soft (optional) branch whose toggle is currently disabled. The
      // node is rendered at low opacity and its prereqs aren't loaded.
      faded?: boolean
    }
  | {
      kind: 'group'
      id: string
      ui: 'dropdown' | 'stacked'
      optionCount: number
      data: DisjunctionData | EitherOrData
      faded?: boolean
    }

// Safety cap for prereq BFS expansion. Corpus-wide the deepest known chain
// is FNH 483's 15-node ladder (CHEM 12 → … → FNH 483 — see the easter-egg
// trigger constants above), so 15 is high enough to render every existing
// chain in full without truncation.
const MAX_DEPTH = 15

const X_STEP = 280
const Y_STEP = 90 // minimum vertical slot per item — wider groups grow past this
const Y_GAP = 20 // additional gap between items when a tall item bumps the slot
const NODE_WIDTH = 200

// Vertical gap between adjacent coreq blocks (and between the topmost
// coreq's bottom edge and the root's top edge). The coreq edge running
// between any two stacked blocks carries the "co-req" label pill
// (`COREQ_EDGE_STYLE`): 10 px text + 4 px vertical labelBgPadding × 2 + 1 px
// border × 2 ≈ 22 px tall. Using the regular Y_GAP here jams the pill
// into the surrounding blocks. Add breathing room on both sides so the
// pill sits cleanly in the gap regardless of which kinds of blocks are
// stacked.
const COREQ_LABEL_PILL_HEIGHT = 22
const COREQ_PILL_BREATHING = 8 // padding between a block edge and the pill
const COREQ_VERTICAL_GAP = COREQ_LABEL_PILL_HEIGHT + COREQ_PILL_BREATHING * 2

// Per-line text height used by the heightOf estimator below.
// 11px font × 1.3 line-height, rounded up.
const TEXT_LINE_HEIGHT = 15

// Edge styling shared by every prereq / coreq edge in the graph. The
// coreq label box (`labelBgStyle`) uses the same dark fill + border as
// the course/program blocks so the floating label visually belongs in
// the rest of the graph instead of popping out as a white pill — only
// the stroke + text stay amber, which is enough to flag the edge as a
// coreq without making the label box feel out of place.
// Edges always specify both sourceHandle and targetHandle. A prereq edge
// flows horizontally (source's right handle → target's left handle); a
// coreq edge flows vertically (source's bottom handle → target's top
// handle). Every node — root, prereq, coreq, dropdown, either-or, or
// note — exposes all four handles (CourseNode / DisjunctionNode /
// EitherOrNode all render four invisible handles), so a coreq node is
// just a regular node whose left handle happens to receive the prereq
// chain and whose bottom handle happens to send the coreq edge.
// Edge strokes/labels reference CSS vars so the graph follows the active
// theme. SVG attributes resolve var() at paint time the same way regular
// CSS does, so no separate light/dark dispatch is needed.
const PREREQ_EDGE_STYLE = {
  sourceHandle: 'right-source',
  targetHandle: 'left-target',
  style: { stroke: 'var(--fg-faint)', strokeWidth: 1.5 },
} as const

const COREQ_EDGE_STYLE = {
  sourceHandle: 'bottom-source',
  targetHandle: 'top-target',
  label: 'co-req',
  style: { stroke: 'var(--highlight)', strokeWidth: 1.5 },
  labelStyle: { fill: 'var(--highlight)', fontSize: 10 },
  labelBgStyle: {
    fill: 'var(--surface-raised)',
    stroke: 'var(--line-soft)',
    strokeWidth: 1,
  },
  labelBgPadding: [4, 6] as [number, number],
  labelBgBorderRadius: 4,
} as const

// "Optional" edge — applied to the immediate edge between a soft prereq's
// first-level block and the downstream target. The dashed style signals
// that the upstream is optional; the SoftEdge custom edge component then
// renders an "optional" button at the path midpoint. Inner edges (i.e.
// edges from prereqs of an opt-in soft block to that block itself) use
// the regular PREREQ_EDGE_STYLE — once the user opts in, those become
// required for that path.
const SOFT_EDGE_STYLE = {
  sourceHandle: 'right-source',
  targetHandle: 'left-target',
  type: 'soft',
  style: { stroke: 'var(--fg-faint)', strokeWidth: 1.5, strokeDasharray: '5 5' },
} as const

// Carried through walkAst whenever the current expression sits inside a
// `kind: 'soft'` wrapper. The key uniquely identifies the wrapper (so the
// toggle button on the edge knows which soft branch to flip), and the
// disabled flag governs whether attachments inside this subtree should
// fade their nodes / suppress upstream walks.
type SoftContext = { key: string; disabled: boolean }

// Block heights aren't measured at render time; they're estimated from
// text length so the column layout can leave the right amount of vertical
// room. Using fixed nominal heights underestimates tall content (long
// course titles, long literal notes, long either-or option text) and lets
// blocks visually overlap their next-slot neighbour. The chars-per-line
// bounds below are intentionally a bit tighter than reality so the
// estimator tends to over-shoot height by one line — extra vertical gap
// is cheap, overlap is the bug we're fixing.
function estimateLines(text: string, charsPerLine: number): number {
  if (!text) return 0
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return 0
  let lines = 1
  let used = 0
  for (const word of words) {
    if (used === 0) {
      used = word.length
    } else if (used + 1 + word.length <= charsPerLine) {
      used += 1 + word.length
    } else {
      lines += 1
      used = word.length
    }
    while (used > charsPerLine) {
      // Single word longer than a line — it wraps internally.
      lines += 1
      used -= charsPerLine
    }
  }
  return lines
}

function heightOf(item: ColumnItem): number {
  if (item.kind === 'course') {
    if (item.role === 'note') {
      // CourseNode 'note': border 1+1 + padding 9+9 = 20 of chrome,
      // italic text wrapping inside ~180px usable width.
      const lines = Math.max(1, estimateLines(item.code, 24))
      return 20 + TEXT_LINE_HEIGHT * lines
    }
    // CourseNode root/known/unknown: 20 chrome + code line + title row
    // (margin 6 + pad 6 + 1px border = 13 between code and title).
    const titleText = item.parsed?.title ?? '(not in calendar)'
    const titleLines = Math.max(1, estimateLines(titleText, 24))
    return 20 + TEXT_LINE_HEIGHT + 13 + TEXT_LINE_HEIGHT * titleLines
  }
  if (item.ui === 'dropdown') {
    const data = item.data as DisjunctionData
    // border 1+1 + outer pad 6+6 = 14 chrome, button ≈ 24.
    let h = 14 + 24
    if (data.detail) {
      const text =
        data.detail.kind === 'literal'
          ? data.detail.text
          : (data.detail.title ?? '(not in calendar)')
      // Detail row usable width ≈ 188px → ~26 chars/line.
      const lines = Math.max(1, estimateLines(text, 26))
      // Detail block separator: margin 6 + pad 6 + 1px border = 13.
      h += 13 + TEXT_LINE_HEIGHT * lines
    }
    return h
  }
  // EitherOr stacked: border 1+1 + outer pad 6+6 + header (text 12 +
  // marginBottom 4) = 30 chrome before the rows.
  const data = item.data as EitherOrData
  let h = 30
  for (let i = 0; i < data.options.length; i++) {
    const opt = data.options[i]
    const text = (opt.label ? `(${opt.label}) ` : '') + opt.display
    // Row inner text width ≈ 156px (radio + gaps eat ~30px). ~22
    // chars/line nominally; use 19 to keep a margin.
    const lines = Math.max(1, estimateLines(text, 19))
    // Each row: border 1+1 + pad 4+4 = 10 chrome + text lines.
    h += 10 + TEXT_LINE_HEIGHT * lines
    if (i < data.options.length - 1) h += 4 // inter-row gap
  }
  return h
}

// Pre-pass: walk the prereq tree once with the same selection logic the
// main BFS uses, recording every dropdown absorption in a code → groupId
// map. Running this *before* the main BFS guarantees the alias map is
// fully populated up front, so that any course processed in the main BFS
// (regardless of order) sees the alias and redirects its edge to the
// dropdown — instead of attaching to a stale regular node that the
// absorption later tries to suppress.
function computeAbsorptions(
  rootCode: string,
  index: Map<string, Chunk>,
  selections: Map<string, number>,
  softDisabled: Map<string, boolean>,
): Map<string, string> {
  const aliases = new Map<string, string>()
  const visited = new Set<string>()

  function visit(code: string, depth: number): void {
    if (depth > MAX_DEPTH) return
    if (visited.has(code)) return
    visited.add(code)
    const chunk = index.get(code)
    if (!chunk) return
    const parsed = parseCourseChunk(chunk)
    const ast = parsePrereq(parsed.prerequisites)
    if (ast) walkAst(ast, code, depth, '', false)
    if (depth === 0) {
      const coreqAst = parsePrereq(parsed.corequisites)
      if (coreqAst) walkAst(coreqAst, code, 0, 'coreq', true)
    }
  }

  function walkAst(
    expr: Expr,
    ownerCode: string,
    depth: number,
    path: string,
    isCoreq: boolean,
  ): void {
    if (depth > MAX_DEPTH) return
    switch (expr.kind) {
      case 'and':
        expr.children.forEach((child, i) =>
          walkAst(child, ownerCode, depth, `${path}.and[${i}]`, isCoreq),
        )
        return
      case 'or': {
        const key = `${ownerCode}::${path}.or`
        const groupId = `grp:${key}`
        const chosenIdx = selections.get(key) ?? 0
        const safeChosen = Math.max(0, Math.min(chosenIdx, expr.children.length - 1))
        const chosenExpr = expr.children[safeChosen]
        if (expr.ui === 'dropdown' && chosenExpr?.kind === 'code') {
          // Last writer wins if the same code is the chosen option of two
          // distinct dropdowns. Rare in practice; matches the main BFS's
          // first-encountered semantics closely enough.
          aliases.set(chosenExpr.code, groupId)
        }
        if (!chosenExpr) return
        if (chosenExpr.kind === 'code') {
          // Absorbed course's prereqs get walked inline by the main BFS.
          // Recurse here for both prereqs and coreqs so deeper absorptions
          // in either chain land in the alias map.
          visit(chosenExpr.code, depth + 1)
        } else if (chosenExpr.kind === 'and' || chosenExpr.kind === 'or') {
          walkAst(
            chosenExpr,
            ownerCode,
            depth + 1,
            `${path}.or[${safeChosen}]`,
            isCoreq,
          )
        }
        return
      }
      case 'code':
        // A coreq leaf is still a course, so its prereqs need to be
        // visited for alias discovery just like a prereq leaf.
        visit(expr.code, depth + 1)
        return
      case 'literal':
        return
      case 'flattened':
        // Walk the structured sub-expression of a flattened either-branch
        // (a single Code, an Or-dropdown, an And of mixed atoms, …) so
        // any deeper absorptions / structures land in the alias map the
        // same way they would if the prose context wasn't around them.
        if (expr.subExpr) {
          walkAst(expr.subExpr, ownerCode, depth, `${path}.flat`, isCoreq)
        }
        return
      case 'soft':
        // Soft / optional wrapper — alias discovery doesn't care about
        // the soft styling, just walk through to the wrapped subtree.
        // Skip the wrapped subtree entirely if the user has toggled this
        // soft branch off; otherwise we'd absorb codes into dropdowns
        // that won't be rendered, leaving stale aliases the main BFS
        // would route phantom edges through.
        if (softDisabled.get(`${ownerCode}::${path}.soft`)) return
        walkAst(expr.child, ownerCode, depth, `${path}.soft`, isCoreq)
        return
    }
  }

  visit(rootCode, 0)
  return aliases
}

function buildGraph(
  rootCode: string,
  index: Map<string, Chunk>,
  selections: Map<string, number>,
  setDropdownSelection: (key: string, idx: number) => void,
  setEitherSelection: (key: string, idx: number) => void,
  softDisabled: Map<string, boolean>,
  toggleSoft: (key: string) => void,
): Graph {
  const rootChunk = index.get(rootCode)
  if (!rootChunk)
    return {
      nodes: [],
      edges: [],
      depthCount: 0,
      isLongestEaster: false,
      bbox: null,
    }
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
  // Dedupe edges by id at the push site. Prereq strings like FNH 161's
  // "FNH 160. FNH 160 and 161 together are credit-excluded with…" produce
  // a parser AST with duplicate `Code(FNH 160)` children — the literal
  // tail's "FNH 160" tokenizes as a real course-code reference even
  // though it's part of a credit-exclusion sentence. Each duplicate
  // child generated a second edge with the same `prereq:source->target`
  // id; React's keyed reconciliation then leaves one of the two `<path>`
  // elements orphaned in the SVG when a sibling selection flip removes
  // the edge from the next render's array. Filtering at push time keeps
  // edge ids unique so the reconciler can do its job.
  const seenEdgeIds = new Set<string>()
  const pushEdge = (edge: Edge): void => {
    const id = typeof edge.id === 'string' ? edge.id : ''
    if (seenEdgeIds.has(id)) return
    seenEdgeIds.add(id)
    edges.push(edge)
  }
  const enqueued = new Set<string>([rootCode])
  const coreqIds = new Set<string>()
  // Courses currently in the graph only because of a soft (optional)
  // branch whose toggle is disabled. They render faded and have no
  // upstream walk. If the same course is later reached through a hard
  // (or enabled-soft) path, attachPrereqCode promotes it: clears the
  // faded flag, removes it from this set, and queues its prereqs.
  const fadedOnly = new Set<string>()
  // When a dropdown's chosen option is a course code, the dropdown block
  // *is* that course in the graph — no separate course node trails it. Any
  // *other* path that would have pointed an edge at the absorbed course
  // code instead points at the dropdown's group id. We compute these
  // aliases up front (pre-pass below) so the alias map is fully populated
  // before the main BFS starts attaching edges — otherwise a course
  // processed before the absorbing OR would slip in pointing at the
  // wrong target.
  const codeAliases = computeAbsorptions(rootCode, index, selections, softDisabled)

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
    softContext: SoftContext | null = null,
  ): void {
    if (depth > MAX_DEPTH) return
    switch (expr.kind) {
      case 'and':
        // AND children all sit at the same "level" as the parent — if the
        // parent is soft, every child's edge to the target is soft too.
        expr.children.forEach((child, i) =>
          walkAst(
            child,
            ownerCode,
            depth,
            `${path}.and[${i}]`,
            targetId,
            isCoreq,
            softContext,
          ),
        )
        return
      case 'soft': {
        // Recommendation wrapper: tag the immediate edge(s) coming out of
        // this subtree with a SoftContext so they render as the dashed
        // SoftEdge variant (with a click-to-toggle "optional" button at
        // the midpoint). When the toggle is currently disabled, the
        // first-level block(s) inside the wrapper still render but at
        // reduced opacity, and we suppress walking their prereqs — this
        // is enforced inside attachPrereqCode / attachNoteLiteral /
        // registerGroup based on softContext.disabled.
        const key = `${ownerCode}::${path}.soft`
        const nextCtx: SoftContext = {
          key,
          disabled: softDisabled.get(key) ?? false,
        }
        walkAst(
          expr.child,
          ownerCode,
          depth,
          `${path}.soft`,
          targetId,
          isCoreq,
          nextCtx,
        )
        return
      }
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
        // Resolve the dropdown's "selected detail". Aliasing was set up in
        // the pre-pass (computeAbsorptions); here we only need the title
        // for the rendered detail row.
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
          } else if (chosenExpr.kind === 'literal') {
            dropdownDetail = { kind: 'literal', text: chosenExpr.text }
          }
        }

        registerGroup(
          groupId,
          key,
          expr,
          safeChosen,
          depth,
          isCoreq,
          dropdownDetail,
          /*faded=*/ softContext?.disabled === true,
        )
        pushEdge(
          softContext
            ? buildSoftEdge(groupId, targetId, softContext)
            : {
                id: `${isCoreq ? 'coreq' : 'prereq'}:${groupId}->${targetId}`,
                source: groupId,
                target: targetId,
                ...(isCoreq ? COREQ_EDGE_STYLE : PREREQ_EDGE_STYLE),
              },
        )

        if (!chosenExpr) return
        // Soft + disabled: the dropdown / either-or block stays in the
        // graph (faded), but we don't expand any of its upstream — the
        // user has explicitly opted out of loading the optional path.
        if (softContext?.disabled) return

        // Dropdown + course → dropdown IS the course; absorb. Walk the
        // absorbed course's own prereqs inline with target = groupId —
        // same logic for prereqs and coreqs. The chosen course (whether
        // it's a prereq dropdown or a coreq dropdown) is still a course,
        // and the user expects its upstream chain to be visible. The
        // edges from those absorbed prereqs are plain prereq edges (gray)
        // because they're prereqs OF the absorbed course, not coreqs of
        // the root.
        if (expr.ui === 'dropdown' && chosenExpr.kind === 'code') {
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
          return
        }

        // Dropdown + literal: detail already shown under the dropdown,
        // nothing to expand.
        if (expr.ui === 'dropdown' && chosenExpr.kind === 'literal') return

        // Either-or stacked, or dropdown with a nested chosen expression:
        // fall through to the existing "edges target groupId" walk. Inner
        // walks drop softContext — once the user opts in via the toggle,
        // the inner expression becomes required for that path, so its
        // edges should render as ordinary (solid) prereq edges.
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
          } else if (chosenExpr.kind === 'flattened') {
            // Walk the flattened branch's structured sub-expression so
            // embedded blocks (e.g. an inline "one of A, B") render as
            // real upstream blocks feeding into this group.
            if (chosenExpr.subExpr) {
              walkAst(
                chosenExpr.subExpr,
                ownerCode,
                depth + 1,
                `${path}.or[${safeChosen}].flat`,
                groupId,
                true,
              )
            }
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
        } else if (chosenExpr.kind === 'flattened') {
          // Flattened branch (e.g. "a score of 80% or higher in one of
          // MATH 101, MATH 103"): display stays as the original prose on
          // the sub-block, but the structured sub-expression — which may
          // be a single Code, an Or-dropdown, or a mix — gets walked
          // upstream so the user sees real blocks (and their transitive
          // prereqs) trailing the literal.
          if (chosenExpr.subExpr) {
            walkAst(
              chosenExpr.subExpr,
              ownerCode,
              depth + 1,
              `${path}.or[${safeChosen}].flat`,
              groupId,
            )
          }
        }
        // literal in stacked: terminates. The radio's text is the only
        // display.
        return
      }
      case 'code':
        if (isCoreq) attachCoreqCode(expr.code, targetId)
        else attachPrereqCode(expr.code, depth, targetId, softContext)
        return
      case 'literal':
        // Any literal that lands here is a real prereq the parser
        // couldn't structure as a course-code subtree (class-standing
        // prose, credit requirements, instructor consent, high-school
        // course names, …). Render it as a small italic info block.
        // normalize() upstream has already collapsed disjunctions/
        // conjunctions of prose into single literals, so we don't get
        // multiple shredded blocks per idiom.
        if (expr.text.trim()) {
          attachNoteLiteral(
            expr.text,
            `${ownerCode}::${path}`,
            depth,
            targetId,
            isCoreq,
            softContext,
          )
        }
        return
      case 'flattened':
        // Top-level flattened (rare — a flattened branch promoted by
        // normalization or a single-branch either): walk the structured
        // sub-expression directly into the current target.
        if (expr.subExpr) {
          walkAst(
            expr.subExpr,
            ownerCode,
            depth,
            `${path}.flat`,
            targetId,
            isCoreq,
            softContext,
          )
        }
        return
    }
  }

  function buildSoftEdge(
    sourceId: string,
    targetId: string,
    ctx: SoftContext,
  ): Edge {
    const data: SoftEdgeData = {
      softKey: ctx.key,
      disabled: ctx.disabled,
      onToggle: toggleSoft,
    }
    return {
      // Include softKey in the id so two distinct soft branches feeding
      // into the same target don't collide on a shared edge id (two
      // dashed lines with the same source/target pair is rare but the
      // id needs to stay unique either way).
      id: `soft:${ctx.key}:${sourceId}->${targetId}`,
      source: sourceId,
      target: targetId,
      ...SOFT_EDGE_STYLE,
      data,
    }
  }

  function attachPrereqCode(
    code: string,
    depth: number,
    targetId: string,
    softContext: SoftContext | null = null,
  ): void {
    // Resolve through codeAliases so that if `code` has been absorbed into
    // a dropdown elsewhere, this edge points at that dropdown's group id
    // (not a phantom course node that doesn't exist).
    const sourceId = codeAliases.get(code) ?? code
    if (sourceId === targetId) return
    pushEdge(
      softContext
        ? buildSoftEdge(sourceId, targetId, softContext)
        : {
            id: `prereq:${sourceId}->${targetId}`,
            source: sourceId,
            target: targetId,
            ...PREREQ_EDGE_STYLE,
          },
    )
    if (codeAliases.has(code)) return

    const isFadedAttach = softContext?.disabled === true

    if (byId.has(code)) {
      // Already in the graph. If we previously added it via a disabled
      // soft path (faded, no upstream walk) and we're now hitting it via
      // a non-faded path, promote: clear the faded flag and walk its
      // prereqs after all. Without this, a course that happens to be
      // both an optional recommendation for X and a hard prereq for Y
      // would lose its upstream chain whenever the optional toggle is
      // off.
      if (!isFadedAttach && fadedOnly.has(code)) {
        fadedOnly.delete(code)
        const existing = byId.get(code)
        if (existing && existing.kind === 'course') {
          byId.set(code, { ...existing, faded: false })
          enqueued.add(code)
          if (existing.parsed) {
            queue.push({ code, parsed: existing.parsed, depth: existing.depth })
          }
        }
      }
      return
    }

    const chunk = index.get(code)
    const parsed = chunk ? parseCourseChunk(chunk) : null
    byId.set(code, {
      kind: 'course',
      id: code,
      code,
      parsed,
      role: 'prereq',
      depth,
      faded: isFadedAttach,
    })
    if (isFadedAttach) {
      // Faded-only attachment: keep the node visible but skip the
      // transitive prereq walk — that's the "prerequisites of that
      // block should not be loaded" half of the soft-disabled UX.
      fadedOnly.add(code)
      return
    }
    enqueued.add(code)
    if (parsed) queue.push({ code, parsed, depth })
  }

  // A class-standing prose block surfaced as a small info node. Same edge
  // styling as a prereq/coreq code, but the source is a synthesized id
  // keyed by `${ownerCode}::${pathInExpr}` so two different courses' notes
  // don't collide. No transitive expansion (it's prose, not a course).
  function attachNoteLiteral(
    text: string,
    key: string,
    depth: number,
    targetId: string,
    isCoreq: boolean,
    softContext: SoftContext | null = null,
  ): void {
    const sourceId = `note:${key}`
    if (sourceId === targetId) return
    pushEdge(
      softContext
        ? buildSoftEdge(sourceId, targetId, softContext)
        : {
            id: `${isCoreq ? 'coreq' : 'prereq'}:${sourceId}->${targetId}`,
            source: sourceId,
            target: targetId,
            ...(isCoreq ? COREQ_EDGE_STYLE : PREREQ_EDGE_STYLE),
          },
    )
    if (byId.has(sourceId)) return
    byId.set(sourceId, {
      kind: 'course',
      id: sourceId,
      code: text,
      parsed: null,
      role: 'note',
      depth: isCoreq ? 0 : depth,
      faded: softContext?.disabled === true,
    })
    if (isCoreq) coreqIds.add(sourceId)
  }

  function attachCoreqCode(code: string, targetId: string): void {
    const sourceId = codeAliases.get(code) ?? code
    if (sourceId === targetId) return
    pushEdge({
      id: `coreq:${sourceId}->${targetId}`,
      source: sourceId,
      target: targetId,
      ...COREQ_EDGE_STYLE,
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
    // Enqueue for transitive prereq walking — a coreq is still a course,
    // and the user expects its upstream chain (prereqs of prereqs of …)
    // to render like any other course node. The walked prereqs come
    // back through attachPrereqCode (isCoreq=false implicit), so they
    // attach as plain prereq edges feeding into the coreq's id.
    if (parsed) queue.push({ code, parsed, depth: 0 })
  }

  function registerGroup(
    groupId: string,
    key: string,
    expr: Expr & { kind: 'or' },
    selectedIdx: number,
    depth: number,
    isCoreq: boolean,
    detail: DisjunctionDetail,
    faded: boolean,
  ): void {
    if (isCoreq) coreqIds.add(groupId)
    if (byId.has(groupId)) return
    // Pick the SFX-flavored selector that matches the rendered block —
    // dropdown blocks call dropdownPick, stacked either-or blocks call
    // eitherPick. The split lives at the parent (PrereqTree) so node
    // components don't have to know about audio.
    const onChange =
      expr.ui === 'dropdown'
        ? (idx: number) => setDropdownSelection(key, idx)
        : (idx: number) => setEitherSelection(key, idx)
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
        faded,
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
        faded,
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
  // Layout-space bbox accumulator. We can't derive this from the final
  // `nodes` array because Node only stores `position.y` (the top edge);
  // computing center as (minTop + maxTop)/2 biases upward by half the
  // bottommost block's height. Pushing through `pushNode` lets each call
  // contribute its real top + bottom while we still have the height in
  // scope. (HorizontalFitOnChange uses this bbox for the vertical center.)
  let bboxMinX = Infinity
  let bboxMaxX = -Infinity
  let bboxMinY = Infinity
  let bboxMaxY = -Infinity
  const pushNode = (node: Node, height: number) => {
    nodes.push(node)
    const { x, y } = node.position
    if (x < bboxMinX) bboxMinX = x
    if (x + NODE_WIDTH > bboxMaxX) bboxMaxX = x + NODE_WIDTH
    if (y < bboxMinY) bboxMinY = y
    if (y + height > bboxMaxY) bboxMaxY = y + height
  }
  // Track top-level coreq item ids in vertical order so we can rewrite
  // their edges into a chain after layout: the topmost coreq's bottom
  // handle connects to the next coreq's top handle, on down to the
  // bottommost coreq, whose edge still terminates at the root.
  const coreqChain: string[] = []

  // Barycenter sort: order each prereq column by the mean y of each item's
  // already-placed successors (the items it feeds into in the next column
  // toward root). Reduces edge crossings vs the prior alphabetical sort —
  // a prereq that only feeds into one downstream node lands at that
  // node's y; one that feeds two diverging targets lands between them.
  // Ties (notably the d1 case where every prereq feeds the root at y=0)
  // fall through to the existing courses-before-groups + alphabetical
  // tiebreak so the order stays deterministic.
  const successors = new Map<string, string[]>()
  for (const e of edges) {
    if (typeof e.source !== 'string' || typeof e.target !== 'string') continue
    const list = successors.get(e.source)
    if (list) list.push(e.target)
    else successors.set(e.source, [e.target])
  }
  const yByItem = new Map<string, number>()
  const baryOf = (item: ColumnItem): number => {
    const succs = successors.get(item.id)
    if (!succs) return 0
    let sum = 0
    let count = 0
    for (const s of succs) {
      const y = yByItem.get(s)
      if (y !== undefined) {
        sum += y
        count++
      }
    }
    return count === 0 ? 0 : sum / count
  }
  const tiebreak = (a: ColumnItem, b: ColumnItem): number => {
    if (a.kind !== b.kind) return a.kind === 'course' ? -1 : 1
    if (a.kind === 'course' && b.kind === 'course') {
      return a.code.localeCompare(b.code)
    }
    return a.id.localeCompare(b.id)
  }

  // Lay out columns shallowest-first (d0, d1, d2, …) so each deeper
  // column can read its successors' y's from `yByItem` when sorting.
  // Coreq column goes last — it's an independent bottom-up stack and
  // doesn't feed any prereq column.
  const sortedColKeys = [...byColumn.keys()].sort((a, b) => {
    if (a === 'coreq') return 1
    if (b === 'coreq') return -1
    return Number(a.slice(1)) - Number(b.slice(1))
  })

  for (const colKey of sortedColKeys) {
    const items = byColumn.get(colKey)!
    const isCoreqCol = colKey === 'coreq'
    if (isCoreqCol) {
      items.sort(tiebreak)
    } else {
      items.sort((a, b) => {
        const da = baryOf(a)
        const db = baryOf(b)
        if (da !== db) return da - db
        return tiebreak(a, b)
      })
    }

    if (isCoreqCol) {
      // Coreq column sits in the same x as the root, stacked directly
      // above it. Items closer to root in the array end up closer to root
      // visually; we iterate bottom-up so the bottommost item lands just
      // above the root with COREQ_VERTICAL_GAP of space, and each item
      // above sits its own height + COREQ_VERTICAL_GAP further up. The
      // coreq edge between adjacent blocks carries the "co-req" label
      // pill at its midpoint, so the gap needs to accommodate the pill's
      // height plus breathing room — Y_GAP alone is too tight.
      const x = 0
      // Coreq stack starts one COREQ_VERTICAL_GAP above the top edge of
      // the root block. The root is centered at y=0 (only item in column
      // d0), so its top edge is -heightOf(root)/2.
      const rootItem = byId.get(rootCode)
      const rootTop = rootItem ? -heightOf(rootItem) / 2 : 0
      // Bottom edge of the next item to place. Subtracting
      // COREQ_VERTICAL_GAP leaves a pill-sized clear band between this
      // item and root (or the previous coreq item below).
      let nextBottomY = rootTop - COREQ_VERTICAL_GAP
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        const h = heightOf(item)
        const positionY = nextBottomY - h
        const opacityStyle = item.faded ? { opacity: 0.4 } : null
        if (item.kind === 'course') {
          const isNote = item.role === 'note'
          const known = item.parsed !== null
          const title = item.parsed?.title ?? '(not in calendar)'
          const variant: CourseNodeVariant = isNote
            ? 'note'
            : known
              ? 'known'
              : 'unknown'
          pushNode(
            {
              id: item.id,
              type: 'course',
              position: { x, y: positionY },
              data: isNote
                ? { variant, text: item.code }
                : { variant, code: item.code, title },
              style: { width: NODE_WIDTH, ...opacityStyle },
            },
            h,
          )
        } else {
          pushNode(
            {
              id: item.id,
              type: item.ui === 'stacked' ? 'eitherOr' : 'disjunction',
              position: { x, y: positionY },
              data: item.data,
              style: { width: NODE_WIDTH, ...opacityStyle },
            },
            h,
          )
        }
        yByItem.set(item.id, positionY + h / 2)
        nextBottomY = positionY - COREQ_VERTICAL_GAP
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
      yByItem.set(item.id, yCenter)

      const opacityStyle = item.faded ? { opacity: 0.4 } : null
      if (item.kind === 'course') {
        const known = item.parsed !== null
        const isRoot = item.role === 'root'
        const isNote = item.role === 'note'
        // Use the real estimated height so a multi-line block stays
        // centered in its slot; falling back to a fixed nominal here
        // would let tall blocks bleed into the next slot.
        const nodeH = heightOf(item)
        const title = item.parsed?.title ?? '(not in calendar)'
        const variant: CourseNodeVariant = isRoot
          ? 'root'
          : isNote
            ? 'note'
            : known
              ? 'known'
              : 'unknown'
        pushNode(
          {
            id: item.id,
            type: 'course',
            position: { x, y: yCenter - nodeH / 2 },
            data: isNote
              ? { variant, text: item.code }
              : { variant, code: item.code, title },
            style: { width: NODE_WIDTH, ...opacityStyle },
          },
          nodeH,
        )
      } else {
        const h = heightOf(item)
        pushNode(
          {
            id: item.id,
            type: item.ui === 'stacked' ? 'eitherOr' : 'disjunction',
            position: { x, y: yCenter - h / 2 },
            data: item.data,
            style: { width: NODE_WIDTH, ...opacityStyle },
          },
          h,
        )
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
        // Every node in the chain is a CourseNode/DisjunctionNode/
        // EitherOrNode with a top-target handle, so the chain edge
        // always lands on top-target regardless of which kind of node
        // sits at the new target.
        edge.targetHandle = 'top-target'
        edge.sourceHandle = 'bottom-source'
      }
    }
  }

  // Easter-egg gilding: when the user lands on the deepest possible chain
  // in the corpus AND the BFS reached the full depth (depth column 14 with
  // root at column 0 = 15 nodes, FNH 483 ← … ← CHEM 12), tag the root's
  // data with `easter: true` so CourseNode swaps to the signature gold
  // styling. The discovery counter increment is fired separately from a
  // useEffect in the component so buildGraph stays a pure function.
  const isLongestEaster =
    rootCode === LONGEST_TREE_ROOT_CODE &&
    depthCount === LONGEST_TREE_DEPTH_COLUMN
  if (isLongestEaster) {
    for (const node of nodes) {
      if (node.id !== rootCode) continue
      const data = node.data as { variant?: CourseNodeVariant }
      if (data.variant === 'root') {
        node.data = { ...node.data, easter: true }
      }
      break
    }
  }

  const bbox =
    nodes.length > 0
      ? {
          minX: bboxMinX,
          maxX: bboxMaxX,
          minY: bboxMinY,
          maxY: bboxMaxY,
        }
      : null
  return { nodes, edges, depthCount, isLongestEaster, bbox }
}

// Horizontal-only auto-fit. ReactFlow's built-in `fitView` fits both axes,
// so a tall narrow tree leaves big horizontal margins because the vertical
// extent becomes the limiting factor. Spec: leftmost and rightmost blocks
// stay in view at all times, even if that means the chart overflows
// vertically and the user pans to reach lower courses. We feed `fitBounds`
// a bbox with the chart's true horizontal extent and a 1-pixel height so
// the horizontal axis always wins the zoom calculation.
//
// Important: `nodes` deliberately does NOT live in this effect's deps,
// because every selection-change rebuilds the nodes array (new object
// identity, new positions for some items) and we don't want to re-fit
// the camera on every dropdown toggle. The effect re-runs only when
// `fitKey` flips (initial mount, root-course lookup), and reads the
// latest `nodes` via a ref so fitBounds always sees the current bbox.
function HorizontalFitOnChange({
  bbox,
  fitKey,
}: {
  bbox: Graph['bbox']
  fitKey: string
}) {
  const { fitBounds } = useReactFlow()
  const bboxRef = useRef(bbox)
  bboxRef.current = bbox
  useEffect(() => {
    // Defer the fit to the next animation frame. When this effect fires
    // on a tab-switch into the prereq view, ReactFlow's ResizeObserver
    // hasn't yet propagated the post-`display:none` wrapper size into
    // its internal store, so width/height are still 0. fitBounds then
    // computes `height / (bounds.height * (1 + padding)) = 0 / 1.05 = 0`
    // and clamps to `minZoom`, which manifests as the camera snapping
    // all the way out instead of in. One rAF is enough for the resize
    // callback + state update to land before we call fitBounds.
    const id = requestAnimationFrame(() => {
      const b = bboxRef.current
      if (!b) return
      // The bbox already accounts for each node's full vertical extent
      // (top + estimated height), so (minY + maxY) / 2 is the true visual
      // center. A 1-pixel-tall bounds keeps the horizontal axis the
      // limiting factor for the zoom calculation.
      fitBounds(
        {
          x: b.minX,
          y: (b.minY + b.maxY) / 2,
          width: b.maxX - b.minX,
          height: 1,
        },
        { padding: 0.05, duration: 200 },
      )
    })
    return () => cancelAnimationFrame(id)
  }, [fitKey, fitBounds])
  return null
}

const NODE_TYPES = {
  disjunction: DisjunctionNode,
  eitherOr: EitherOrNode,
  course: CourseNode,
} as const

const EDGE_TYPES = {
  soft: SoftEdge,
} as const

export function PrereqTree() {
  const [index, setIndex] = useState<Map<string, Chunk> | null>(null)
  const [query, setQuery] = useState('COGS 300')
  const [activeCode, setActiveCode] = useState<string | null>('COGS 300')
  // Per-disjunction selection map. Keys are `${ownerCourseCode}::${path}`
  // — stable across re-renders so toggling one selection doesn't disturb
  // unrelated ones. Defaults are option 0 when a key is absent, so the
  // initial render always shows a fully-populated tree. Survives root-
  // course switches.
  const [selections, setSelections] = useState<Map<string, number>>(
    () => new Map(),
  )
  // Per-soft-branch toggle map. Keys are `${ownerCourseCode}::${path}.soft`
  // — same shape as the disjunction selection keys, so two soft branches
  // in the same course (or the same soft branch in two courses) don't
  // collide. Default-absent means "expanded" (subtree fully loaded);
  // flipping to true fades the soft block and skips loading its
  // upstream prereqs.
  const [softDisabled, setSoftDisabled] = useState<Map<string, boolean>>(
    () => new Map(),
  )

  // Single core mutator. Each surface (dropdown / either-or) has its own
  // outer callback that plays its own SFX before delegating here — that
  // way the buildGraph layout doesn't need to know which kind of block
  // emitted the change, and the sound differentiation lives at the call
  // site instead of being threaded through node props.
  const applySelection = useCallback((key: string, idx: number) => {
    setSelections((prev) => {
      const next = new Map(prev)
      next.set(key, idx)
      return next
    })
  }, [])

  const setDropdownSelection = useCallback(
    (key: string, idx: number) => {
      // Match the theme-select pick sound in OtherPage so all "picked an
      // option from a dropdown" surfaces feel consistent. Either-or
      // blocks keep their distinct `eitherPick` since they're not
      // dropdowns (radio-style stacked picker).
      playSfx('click')
      applySelection(key, idx)
    },
    [applySelection],
  )

  const setEitherSelection = useCallback(
    (key: string, idx: number) => {
      playSfx('eitherPick')
      applySelection(key, idx)
    },
    [applySelection],
  )

  const toggleSoft = useCallback((key: string) => {
    playSfx('toggle')
    setSoftDisabled((prev) => {
      const next = new Map(prev)
      next.set(key, !(prev.get(key) ?? false))
      return next
    })
  }, [])

  // Re-trigger the horizontal fit every time the user navigates back into
  // the prereq view. PrereqTree is mounted once at app start (App.tsx
  // toggles visibility with `display: none` to preserve local state across
  // tab switches), so the initial HorizontalFitOnChange run happens while
  // the container is hidden and ReactFlow can't measure its viewport —
  // the fit silently no-ops. By bumping `viewOpens` on each transition
  // into the prereq tab and folding it into `fitKey`, the effect re-fires
  // once the container is actually visible.
  const view = useConversations((s) => s.view)
  const [viewOpens, setViewOpens] = useState(0)
  useEffect(() => {
    if (view === 'prereq') setViewOpens((c) => c + 1)
  }, [view])

  useEffect(() => {
    void getCourseIndex().then(setIndex)
  }, [])

  const graph = useMemo(() => {
    if (!index || !activeCode)
      return {
        nodes: [],
        edges: [],
        depthCount: 0,
        isLongestEaster: false,
        bbox: null,
      }
    return buildGraph(
      activeCode,
      index,
      selections,
      setDropdownSelection,
      setEitherSelection,
      softDisabled,
      toggleSoft,
    )
  }, [
    index,
    activeCode,
    selections,
    setDropdownSelection,
    setEitherSelection,
    softDisabled,
    toggleSoft,
  ])

  const root = useMemo(() => {
    if (!index || !activeCode) return null
    const chunk = index.get(activeCode)
    return chunk ? parseCourseChunk(chunk) : null
  }, [index, activeCode])

  // Easter-egg discovery: fire markDiscovered when the user's lookup hits
  // FNH 483 and the tree expanded all the way out (depthCount = 14 = 15
  // nodes). markDiscovered is idempotent in the store, so re-rendering the
  // same tree on a re-mount or a soft-toggle won't double-count — but
  // gating on the raw flag keeps the call out of the dependency graph
  // entirely until the condition flips true.
  useEffect(() => {
    if (!graph.isLongestEaster) return
    useEasterEggs.getState().markDiscovered(LONGEST_PREREQ_TREE_EASTER_ID)
  }, [graph.isLongestEaster])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!index) return
    // Mirror the chat composer's one-shot `send` chime so the two
    // submit-by-Enter surfaces feel like the same gesture. The lookup
    // result is synchronous, so we deliberately don't tack on a
    // success/error follow-up.
    playSfx('send')
    const code = normalize(query)
    if (index.has(code)) setActiveCode(code)
    else setActiveCode(null)
  }

  return (
    <div className="flex flex-col h-screen p-4 gap-3 w-full">
      <header className="flex items-center gap-3">
        <h2 className="text-xl font-semibold">Prerequisite Tree</h2>
        <span className="text-xs text-fg-faint">
          full transitive chain · boolean structure modeled
        </span>
      </header>

      <form onSubmit={submit} className="flex gap-2 max-w-md">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value.toUpperCase())}
          placeholder="e.g. CPSC 320"
          className="flex-1 rounded bg-input border border-line-soft text-fg px-3 py-2 text-sm focus:outline-none focus:border-fg-faint"
        />
        <button
          type="submit"
          className="rounded bg-accent hover:bg-accent-hover text-accent-fg px-3 py-2 text-sm"
        >
          Show
        </button>
      </form>

      {!index && <p className="text-fg-faint">Loading course index…</p>}

      {index && !activeCode && (
        <p className="text-sm text-danger-fg">
          No course found. Try a code like CPSC 110 or MATH 200.
        </p>
      )}

      {root && (
        <p className="text-xs text-fg-muted">
          Showing every transitive prerequisite of{' '}
          <span className="text-fg">{root.code}</span>
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

      <div className="flex-1 rounded border border-line bg-canvas">
        {graph.nodes.length > 0 ? (
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
          >
            {/* ReactFlow's Background renders SVG <circle> dots whose
                fill resolves CSS variables, so a token reference works
                here and lets the grid follow the active theme: zinc-700
                in dark, zinc-300 in light. */}
            <Background color="var(--line-soft)" gap={16} />
            <Controls showInteractive={false} />
            <HorizontalFitOnChange
              bbox={graph.bbox}
              fitKey={`${activeCode ?? ''}::${viewOpens}`}
            />
          </ReactFlow>
        ) : (
          <div className="h-full flex items-center justify-center text-fg-faint text-sm">
            Enter a course code to render its prerequisite graph.
          </div>
        )}
      </div>

      {root && isNoneOrEmpty(root.prerequisites) && isNoneOrEmpty(root.corequisites) && (
        <p className="text-sm text-fg-muted">
          {root.code} has no prerequisites or corequisites listed in the calendar.
        </p>
      )}
    </div>
  )
}
