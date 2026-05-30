// Degree Planner page. Four+-column year canvas with per-term course
// blocks, drag-and-drop reordering, prereq/coreq validation, and a right
// sidebar holding the program selector + mini-lookup + trash zone.
//
// DnD architecture: one DndContext for the whole page. Three drag sources
// (sortable course blocks, draggable lookup results, ghost overlay) and
// two drop targets (term sections, trash bin). onDragEnd switches on the
// active.id prefix and the over.id to route the move/add/delete.
import { useEffect, useMemo, useState, type ComponentType } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  usePlanner,
  type PlannerSidebarTab,
  type Year,
} from '../store/planner'
import { playSfx } from '../lib/sfx'
import {
  getCourseIndex,
  parseCourseChunk,
  type Chunk,
} from '../lib/retrieve'
import {
  isSatisfied,
  missingPrereqs,
  parsePrereq,
  type Expr,
} from '../lib/prereqAst'
import { getRequirementsFor } from '../lib/programRequirements'
import {
  parseProgramYears,
  hasYearRequirements,
  isRequirementMet,
  requirementKey,
} from '../lib/programYears'
import { YearColumn } from './planner/YearColumn'
import { TrashBin } from './planner/TrashBin'
import { MiniCourseLookup } from './planner/MiniCourseLookup'
import { PlanStructure } from './planner/PlanStructure'
import { ProgramSelectors, ProgramProgress } from './planner/ProgramRequirements'
import { CourseBlock } from './planner/CourseBlock'
import {
  EMPTY_VALIDATION,
  type BlockValidation,
} from './planner/validation'
import { LookupBlock } from './planner/LookupBlock'
import {
  BookIcon,
  ChatIcon,
  CheckSquareIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeOffIcon,
  InfoIcon,
  SparklesIcon,
  TrashIcon,
  type IconProps,
} from './icons'

const ACTIVE_BLOCK_PREFIX = 'block:'
const ACTIVE_LOOKUP_PREFIX = 'lookup:'
const TERM_PREFIX = 'term:'

// Resolve drop targets in priority order:
//  1. Trash — only when the pointer is literally inside the trash drop
//     zone (pointerWithin).
//  2. Sortable blocks — only when the pointer is literally inside a
//     block (pointerWithin again). This gives precise reorder positions
//     when the user hovers a destination block, and crucially *fails*
//     when the cursor is over an empty term, instead of snapping to
//     "whatever block is geometrically closest" — that previous behaviour
//     masked every empty term because closestCenter always wins.
//  3. Term containers — closestCenter falls back here so dropping in the
//     blank area of a term still lands you in that term, even if it's
//     visually a bit far from any block.
const blockFirstCollision: CollisionDetection = (args) => {
  const activeId = String(args.active.id)
  const isBlockOrLookup =
    activeId.startsWith(ACTIVE_BLOCK_PREFIX) ||
    activeId.startsWith(ACTIVE_LOOKUP_PREFIX)
  if (isBlockOrLookup) {
    const trashHit = pointerWithin({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (c) => String(c.id) === 'trash',
      ),
    })
    if (trashHit.length > 0) return trashHit

    const blockHit = pointerWithin({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) =>
        String(c.id).startsWith(ACTIVE_BLOCK_PREFIX),
      ),
    })
    if (blockHit.length > 0) return blockHit
  }
  // Last resort: closest term. Filter the candidate set so we don't
  // accidentally resolve to a far-away block again.
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => {
      const id = String(c.id)
      return id.startsWith(TERM_PREFIX) || id === 'trash'
    }),
  })
}

export function Planning() {
  const years = usePlanner((s) => s.years)
  const addBlock = usePlanner((s) => s.addBlock)
  const moveBlock = usePlanner((s) => s.moveBlock)
  const removeBlock = usePlanner((s) => s.removeBlock)
  const clearAllBlocks = usePlanner((s) => s.clearAllBlocks)
  const ignoredBlocks = usePlanner((s) => s.ignoredBlocks)
  const sidebarCollapsed = usePlanner((s) => s.sidebarCollapsed)
  const sidebarTab = usePlanner((s) => s.sidebarTab)
  const setSidebarTab = usePlanner((s) => s.setSidebarTab)
  const toggleSidebar = usePlanner((s) => s.toggleSidebar)

  const [courseIndex, setCourseIndex] =
    useState<Map<string, Chunk> | null>(null)
  const [activeDrag, setActiveDrag] = useState<
    | { kind: 'block'; blockId: string; code: string }
    | { kind: 'lookup'; code: string }
    | null
  >(null)

  useEffect(() => {
    void getCourseIndex().then(setCourseIndex)
  }, [])

  const sensors = useSensors(
    // 4-px activation distance so a click on a block (e.g. to read the
    // tooltip) doesn't immediately start a drag and consume the event.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  )

  // Per-block validation. Walks years/terms in order, building the
  // cumulative completed-set as we go: prereqs check against strictly-
  // earlier terms, coreqs check against earlier-or-same. Recomputes
  // whenever the years tree changes or the course index resolves.
  const ignoredSet = useMemo(() => new Set(ignoredBlocks), [ignoredBlocks])

  const validations = useMemo<Map<string, BlockValidation>>(() => {
    const out = new Map<string, BlockValidation>()
    if (!courseIndex) return out
    const cumulative = new Set<string>()
    for (const year of years) {
      for (const term of year.terms) {
        const codesThisTerm = new Set(term.blocks.map((b) => b.code))
        const completedBefore = new Set(cumulative)
        const completedSameOrBefore = new Set([
          ...cumulative,
          ...codesThisTerm,
        ])
        for (const block of term.blocks) {
          const chunk = courseIndex.get(block.code)
          if (!chunk) {
            out.set(block.id, {
              ok: true,
              missing: [],
              completedBefore,
              completedSameOrBefore,
            })
            continue
          }
          const parsed = parseCourseChunk(chunk)
          const prereqAst = parsePrereq(parsed.prerequisites)
          const coreqAst = parsePrereq(parsed.corequisites)
          const missing: string[] = []
          if (prereqAst && !isSatisfied(prereqAst, completedBefore)) {
            missing.push(
              ...missingPrereqs(prereqAst, completedBefore).map(
                (m) => `prereq ${m}`,
              ),
            )
          }
          if (coreqAst && !isSatisfied(coreqAst, completedSameOrBefore)) {
            missing.push(
              ...missingPrereqs(coreqAst, completedSameOrBefore).map(
                (m) => `coreq ${m}`,
              ),
            )
          }
          const ignored = ignoredSet.has(block.id)
          out.set(block.id, {
            ok: missing.length === 0 || ignored,
            missing,
            completedBefore,
            completedSameOrBefore,
          })
        }
        for (const code of codesThisTerm) cumulative.add(code)
      }
    }
    return out
  }, [years, courseIndex, ignoredSet])

  const plannedCodes = useMemo(() => {
    const out = new Set<string>()
    for (const year of years) {
      for (const term of year.terms) {
        for (const block of term.blocks) out.add(block.code)
      }
    }
    return out
  }, [years])

  function findBlockYearTerm(
    blockId: string,
  ): { year: Year; termIdx: number; pos: number } | null {
    for (const year of years) {
      for (let ti = 0; ti < year.terms.length; ti++) {
        const pos = year.terms[ti].blocks.findIndex((b) => b.id === blockId)
        if (pos !== -1) return { year, termIdx: ti, pos }
      }
    }
    return null
  }

  function onDragStart(event: DragStartEvent) {
    const id = String(event.active.id)
    if (id.startsWith(ACTIVE_BLOCK_PREFIX)) {
      const blockId = id.slice(ACTIVE_BLOCK_PREFIX.length)
      for (const year of years) {
        for (const term of year.terms) {
          const b = term.blocks.find((x) => x.id === blockId)
          if (b) {
            setActiveDrag({ kind: 'block', blockId, code: b.code })
            playSfx('dragLift')
            return
          }
        }
      }
      return
    }
    if (id.startsWith(ACTIVE_LOOKUP_PREFIX)) {
      setActiveDrag({
        kind: 'lookup',
        code: id.slice(ACTIVE_LOOKUP_PREFIX.length),
      })
      playSfx('dragLift')
    }
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveDrag(null)
    const { active, over } = event
    if (!over) {
      playSfx('dragCancel')
      return
    }
    const activeId = String(active.id)
    const overId = String(over.id)

    // === Lookup → term: spawn a new block. Dropping a lookup on trash
    // is a no-op (you can't delete something that never existed). ===
    if (activeId.startsWith(ACTIVE_LOOKUP_PREFIX)) {
      const code = activeId.slice(ACTIVE_LOOKUP_PREFIX.length)
      if (!code) { playSfx('dragCancel'); return }
      if (overId === 'trash') { playSfx('dragCancel'); return }
      // Drop target can be either a term container or another block
      // inside one (closestCenter likes to resolve to the nearest sortable
      // item). Walk the data to recover (yearId, termIdx).
      const dest = resolveTermDrop(overId, years)
      if (!dest) { playSfx('dragCancel'); return }
      addBlock(dest.yearId, dest.termIdx, code)
      playSfx('dragDrop')
      return
    }

    // === Block → trash: delete. ===
    if (overId === 'trash' && activeId.startsWith(ACTIVE_BLOCK_PREFIX)) {
      removeBlock(activeId.slice(ACTIVE_BLOCK_PREFIX.length))
      playSfx('plannerTrash')
      return
    }

    // === Block → term (or another block): move/reorder. ===
    if (activeId.startsWith(ACTIVE_BLOCK_PREFIX)) {
      const blockId = activeId.slice(ACTIVE_BLOCK_PREFIX.length)
      const src = findBlockYearTerm(blockId)
      if (!src) { playSfx('dragCancel'); return }
      const dest = resolveTermDrop(overId, years)
      if (!dest) { playSfx('dragCancel'); return }
      let insertPos = dest.pos
      if (insertPos === -1) {
        const destTerm = years.find((y) => y.id === dest.yearId)?.terms[
          dest.termIdx
        ]
        insertPos = destTerm?.blocks.length ?? 0
      } else if (
        src.year.id === dest.yearId &&
        src.termIdx === dest.termIdx &&
        src.pos < dest.pos
      ) {
        // Dragging downward within the same term: insert AFTER the
        // target block so the move is visible. Without this +1 the
        // `sourcePos < toPos` adjustment in moveBlock collapses the
        // move back to the original position.
        insertPos = dest.pos + 1
      }
      moveBlock(blockId, dest.yearId, dest.termIdx, insertPos)
      playSfx('dragDrop')
    }
  }

  if (!courseIndex) {
    return (
      <div className="p-6 text-fg-faint">Loading course index…</div>
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={blockFirstCollision}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="flex h-full min-h-0 flex-col p-4">
        <div
          className="flex-1 min-h-0 grid gap-4"
          style={{
            gridTemplateColumns: sidebarCollapsed
              ? 'minmax(0,1fr) 2.5rem'
              : 'minmax(0,1fr) 20rem',
          }}
        >
          <div className="min-h-0 flex flex-col gap-3">
            <header className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">Degree Planner</h2>
              </div>
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              <div
                className="grid gap-3 h-full"
                style={{
                  gridTemplateColumns: `repeat(${years.length}, minmax(0, 1fr))`,
                }}
              >
                {years.map((year) => (
                  <YearColumn
                    key={year.id}
                    year={year}
                    courseIndex={courseIndex}
                    validations={validations}
                  />
                ))}
              </div>
            </div>
          </div>

          {sidebarCollapsed ? (
            <CollapsedSidebar
              onExpand={(tab) => {
                setSidebarTab(tab)
                toggleSidebar()
                playSfx('expand')
              }}
              onToggle={() => { toggleSidebar(); playSfx('expand') }}
            />
          ) : (
            <aside className="flex flex-col gap-2 min-h-0 rounded border border-line bg-surface-soft p-4">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => { toggleSidebar(); playSfx('collapse') }}
                  className="rounded p-1 text-fg-muted hover:bg-surface-raised hover:text-fg"
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar"
                >
                  <ChevronRightIcon className="w-4 h-4" />
                </button>
                <div className="flex-1 flex gap-1">
                  <SidebarTabButton
                    active={sidebarTab === 'preferences'}
                    onClick={() => { setSidebarTab('preferences'); playSfx('tab') }}
                    label="Info"
                    Icon={InfoIcon}
                  />
                  <SidebarTabButton
                    active={sidebarTab === 'progress'}
                    onClick={() => { setSidebarTab('progress'); playSfx('tab') }}
                    label="Progress"
                    Icon={CheckSquareIcon}
                  />
                  <SidebarTabButton
                    active={sidebarTab === 'courses'}
                    onClick={() => { setSidebarTab('courses'); playSfx('tab') }}
                    label="Courses"
                    Icon={BookIcon}
                  />
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto pr-2">
                {sidebarTab === 'preferences' && (
                  <div className="flex flex-col gap-4">
                    <PlanStructure />
                    <ProgramSelectors />
                  </div>
                )}
                {sidebarTab === 'progress' && (
                  <ProgramProgress
                    courseIndex={courseIndex}
                    plannedCodes={plannedCodes}
                  />
                )}
                {sidebarTab === 'courses' && (
                  <MiniCourseLookup courseIndex={courseIndex} />
                )}
              </div>
              {/* Actions live as a footer under the Courses tab, just above
                  the trash bin. */}
              {sidebarTab === 'courses' && (
                <ActionsSection
                  years={years}
                  validations={validations}
                  ignoredSet={ignoredSet}
                  courseIndex={courseIndex}
                  plannedCodes={plannedCodes}
                  onClearAll={() => {
                    const total = years.reduce(
                      (n, y) =>
                        n + y.terms.reduce((m, t) => m + t.blocks.length, 0),
                      0,
                    )
                    if (total === 0) return
                    if (
                      window.confirm(
                        `Remove all ${total} course(s) from the plan?`,
                      )
                    ) {
                      clearAllBlocks()
                      playSfx('plannerClear')
                    }
                  }}
                />
              )}
              {/* Trash sits outside the tab area so it's always a valid
                  drop target regardless of which page is showing. */}
              <TrashBin />
            </aside>
          )}
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {activeDrag?.kind === 'block' && (
          <CourseBlock
            blockId={activeDrag.blockId}
            code={activeDrag.code}
            chunk={courseIndex.get(activeDrag.code)}
            validation={
              validations.get(activeDrag.blockId) ?? EMPTY_VALIDATION
            }
            ghost
          />
        )}
        {activeDrag?.kind === 'lookup' &&
          courseIndex.get(activeDrag.code) && (
            <div style={{ width: '18rem' }}>
              <LookupBlock chunk={courseIndex.get(activeDrag.code)!} ghost />
            </div>
          )}
      </DragOverlay>
    </DndContext>
  )
}

function SidebarTabButton({
  active,
  onClick,
  label,
  Icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  Icon: ComponentType<IconProps>
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded px-2 py-1 text-xs flex items-center justify-center gap-2 transition-colors ${
        active
          ? 'bg-surface-raised text-fg'
          : 'text-fg-muted hover:bg-surface-raised hover:text-fg'
      }`}
    >
      <Icon className="w-3.5 h-3.5 text-accent" />
      <span>{label}</span>
    </button>
  )
}

// Slim strip shown when the right sidebar is collapsed. Holds the expand
// arrow, page-icon shortcuts (click to expand + jump to that page), and
// the trash drop zone so deletion still works without expanding.
function CollapsedSidebar({
  onExpand,
  onToggle,
}: {
  onExpand: (tab: PlannerSidebarTab) => void
  onToggle: () => void
}) {
  return (
    <aside className="flex flex-col items-center gap-2 rounded border border-line bg-surface-soft p-1">
      <button
        type="button"
        onClick={onToggle}
        className="rounded p-1 text-fg-muted hover:bg-surface-raised hover:text-fg w-full flex justify-center"
        aria-label="Expand sidebar"
        title="Expand sidebar"
      >
        <ChevronLeftIcon className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => onExpand('preferences')}
        className="rounded p-1 text-fg-muted hover:bg-surface-raised hover:text-fg w-full flex justify-center"
        title="Info"
      >
        <InfoIcon className="w-4 h-4 text-accent" />
      </button>
      <button
        type="button"
        onClick={() => onExpand('progress')}
        className="rounded p-1 text-fg-muted hover:bg-surface-raised hover:text-fg w-full flex justify-center"
        title="Progress"
      >
        <CheckSquareIcon className="w-4 h-4 text-accent" />
      </button>
      <button
        type="button"
        onClick={() => onExpand('courses')}
        className="rounded p-1 text-fg-muted hover:bg-surface-raised hover:text-fg w-full flex justify-center"
        title="Courses"
      >
        <BookIcon className="w-4 h-4 text-accent" />
      </button>
      <div className="flex-1" />
      <TrashBin compact />
    </aside>
  )
}

const YEAR_ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth']

// Map a parsed requirement-year label ("First Year", "Third and Fourth Years",
// "Year 2") to the plan's 0-based year indices it should fill, clamped to the
// number of years in the plan so nothing is lost off the end.
function mapYearToPlanIndices(label: string, planYearCount: number): number[] {
  const lower = label.toLowerCase()
  const idxs = new Set<number>()
  YEAR_ORDINALS.forEach((word, i) => {
    if (lower.includes(word)) idxs.add(Math.min(i, planYearCount - 1))
  })
  const numMatch = lower.match(/year\s+(\d)/)
  if (numMatch) idxs.add(Math.min(Number(numMatch[1]) - 1, planYearCount - 1))
  return [...idxs].sort((a, b) => a - b)
}

function ActionsSection({
  years,
  validations,
  ignoredSet,
  courseIndex,
  plannedCodes,
  onClearAll,
}: {
  years: Year[]
  validations: Map<string, BlockValidation>
  ignoredSet: Set<string>
  courseIndex: Map<string, Chunk>
  plannedCodes: Set<string>
  onClearAll: () => void
}) {
  const major = usePlanner((s) => s.major)
  const addBlock = usePlanner((s) => s.addBlock)
  const preferredCoursesPerTerm = usePlanner((s) => s.preferredCoursesPerTerm)
  const toggleIgnoreBlock = usePlanner((s) => s.toggleIgnoreBlock)
  const checkedRequirements = usePlanner((s) => s.checkedRequirements)
  const [ignoreOpen, setIgnoreOpen] = useState(false)
  const [filling, setFilling] = useState(false)

  const erroredBlocks = useMemo(() => {
    const out: { id: string; code: string }[] = []
    for (const year of years) {
      for (const term of year.terms) {
        for (const block of term.blocks) {
          const v = validations.get(block.id)
          if (v && v.missing.length > 0) out.push(block)
        }
      }
    }
    return out
  }, [years, validations])

  // Fill the plan straight from the Progress checklist: place the courses each
  // year's requirements call for, into the matching plan year. For a "one of"
  // choice only the first listed course is added; an "all of" group adds all of
  // them. Requirements already fulfilled — a satisfying course already in the
  // plan, or a manual check — are skipped.
  async function handleAutofill() {
    if (!major) {
      window.alert('Select a major / program first.')
      return
    }
    setFilling(true)
    try {
      const req = await getRequirementsFor(major)
      const parsed = req?.kind === 'prose' ? parseProgramYears(req.text) : null
      if (!req || !parsed || !hasYearRequirements(parsed)) {
        window.alert('No year-by-year requirements found for this program.')
        return
      }
      const checked = new Set(checkedRequirements)
      const planned = new Set(plannedCodes)

      // 1) Gather courses to place, grouped by requirement block so we can
      //    fill year by year. One-of → first listed course; all-of → every
      //    course. Skip fulfilled / unknown / already-planned.
      const blocks: { years: number[]; codes: string[] }[] = []
      for (const pyear of parsed.years) {
        const blockYears = mapYearToPlanIndices(pyear.label, years.length)
        if (blockYears.length === 0) continue
        const blockCodes: string[] = []
        for (const item of pyear.items) {
          if (item.kind !== 'course') continue
          const key = requirementKey(req.program_url, pyear.label, item)
          if (isRequirementMet(item, planned) || checked.has(key)) continue
          const chosen =
            item.mode === 'oneof' ? item.codes.slice(0, 1) : item.codes
          for (const code of chosen) {
            if (!courseIndex.has(code) || planned.has(code)) continue
            planned.add(code)
            blockCodes.push(code)
          }
        }
        if (blockCodes.length > 0) blocks.push({ years: blockYears, codes: blockCodes })
      }
      if (blocks.length === 0) {
        window.alert('All requirements are already in the plan or fulfilled.')
        return
      }

      // 2) Prerequisite references (codes named in a course's prereq text) that
      //    are themselves in the plan. The `_V` campus suffix is optional in the
      //    source text, so allow it. Then a cycle-safe topological order over
      //    all pending courses (prereqs before dependents); within a block we
      //    place in this order so a course's prereqs claim the earlier terms
      //    before it does.
      const planSet = new Set(planned)
      const astCodes = (e: Expr | null): string[] => {
        if (!e) return []
        switch (e.kind) {
          case 'code':
            return [e.code]
          case 'and':
          case 'or':
            return e.children.flatMap(astCodes)
          case 'flattened':
            return astCodes(e.subExpr)
          case 'soft':
            return astCodes(e.child)
          default:
            return []
        }
      }
      // A prerequisite counts as an ordering edge only when it is "critical" —
      // the course's prereq expression is NOT satisfiable by the plan without
      // it. This ignores alternatives ("one of …") and corequisite mentions the
      // plan covers another way, so we don't invent dependency chains that can't
      // fit the year (e.g. BIOL 200 names CHEM 203 only as a coreq of one
      // branch, so it must NOT force CHEM 203 → BIOL 200).
      // Codes in a requirement expression the plan can't satisfy without —
      // ignores "one of …" alternatives so we don't invent impossible chains.
      const criticalRefs = (reqText: string | null | undefined): string[] => {
        const ast = parsePrereq(reqText)
        if (!ast || !isSatisfied(ast, planSet)) return []
        const refs = [...new Set(astCodes(ast))].filter((c) => planSet.has(c))
        return refs.filter((c) => {
          const without = new Set(planSet)
          without.delete(c)
          return !isSatisfied(ast, without)
        })
      }
      const prereqRefs = (code: string): string[] => {
        const chunk = courseIndex.get(code)
        if (!chunk) return []
        return criticalRefs(parseCourseChunk(chunk).prerequisites)
      }
      const coreqRefs = (code: string): string[] => {
        const chunk = courseIndex.get(code)
        if (!chunk) return []
        return criticalRefs(parseCourseChunk(chunk).corequisites)
      }
      // Scheduling dependencies = critical prereqs + critical coreqs. A coreq
      // must be same-term-or-before; we treat it like a prereq (earlier term),
      // which always satisfies that rule and keeps the scheduler simple.
      const depRefs = (code: string): string[] => {
        const pre = prereqRefs(code)
        const co = coreqRefs(code).filter((c) => !pre.includes(c))
        return [...pre, ...co]
      }
      // 3) Linear (year, term) slot model, seeded with the existing plan so
      //    prereq-ordering and balancing account for courses already placed.
      const slotGlobal = new Map<string, number>()
      const slotLoad = new Map<number, number>()
      let g = 0
      years.forEach((year, y) => {
        year.terms.forEach((_term, t) => {
          slotGlobal.set(`${y}:${t}`, g)
          slotLoad.set(g, 0)
          g++
        })
      })
      const codeSlot = new Map<string, number>()
      years.forEach((year, y) => {
        year.terms.forEach((term, t) => {
          const gi = slotGlobal.get(`${y}:${t}`)!
          for (const b of term.blocks) {
            codeSlot.set(b.code, gi)
            slotLoad.set(gi, (slotLoad.get(gi) ?? 0) + 1)
          }
        })
      })

      // 4) Fill block by block in year order. Within a block, a course's
      //    earliest term is its prerequisite-chain depth *within the block*
      //    (ASAP scheduling): a course that is itself a prerequisite of another
      //    course in the block is pinned to the earliest term it's eligible
      //    for, while leaf courses (no dependents in the block) are free to
      //    move to a later, less-loaded term to balance the load. This keeps
      //    prereqs strictly before dependents — even when both fall in the same
      //    requirement year — and spreads courses across terms.
      let placed = 0
      const orderedBlocks = [...blocks].sort(
        (a, b) => Math.min(...a.years) - Math.min(...b.years),
      )
      for (const block of orderedBlocks) {
        const slots = block.years
          .filter((y) => years[y])
          .flatMap((y) =>
            years[y].terms.map((_term, t) => ({
              yearIdx: y,
              termIdx: t,
              gi: slotGlobal.get(`${y}:${t}`)!,
            })),
          )
          .sort((a, b) => a.gi - b.gi)
        if (slots.length === 0) continue

        // Critical-prereq edges among this block's own courses, and whether a
        // course has any dependent inside the block.
        const blockSet = new Set(block.codes)
        const blockPrereqs = new Map(
          block.codes.map((c) => [
            c,
            depRefs(c).filter((p) => blockSet.has(p)),
          ]),
        )
        const hasDependent = new Set<string>()
        for (const c of block.codes)
          for (const p of blockPrereqs.get(c) ?? []) hasDependent.add(p)

        // Block-local longest prerequisite-chain depth → the course's earliest
        // term index within this block.
        const depthMemo = new Map<string, number>()
        const depthIn = (c: string, stack = new Set<string>()): number => {
          const cached = depthMemo.get(c)
          if (cached != null) return cached
          if (stack.has(c)) return 0
          stack.add(c)
          let d = 0
          for (const p of blockPrereqs.get(c) ?? [])
            d = Math.max(d, depthIn(p, stack) + 1)
          stack.delete(c)
          depthMemo.set(c, d)
          return d
        }

        // Place shallow courses first so a prerequisite's slot is fixed before
        // its dependents are placed.
        const ordered = [...block.codes].sort((a, b) => depthIn(a) - depthIn(b))
        for (const code of ordered) {
          // Floor 1: after any prerequisite already placed (earlier block/year
          // or earlier in this block). Floor 2: this course's own block-depth.
          let minGi = 0
          for (const p of depRefs(code)) {
            const ps = codeSlot.get(p)
            if (ps != null) minGi = Math.max(minGi, ps + 1)
          }
          const depthFloor = Math.min(depthIn(code), slots.length - 1)
          const eligible = slots.filter(
            (s, i) => s.gi >= minGi && i >= depthFloor,
          )
          const pool = eligible.length > 0 ? eligible : [slots[slots.length - 1]]
          // Aim for the preferred per-term load: prefer eligible terms still
          // under it. It's a soft target, not a cap — if every eligible term is
          // already at/over the preference, fall back to the full pool and let
          // a term run heavy rather than drop a required course.
          const underPref = pool.filter(
            (s) => (slotLoad.get(s.gi) ?? 0) < preferredCoursesPerTerm,
          )
          const choosePool = underPref.length > 0 ? underPref : pool
          // A course with dependents stays as early as possible (leave room for
          // them); a leaf goes to the least-loaded eligible term to balance.
          const target = hasDependent.has(code)
            ? choosePool[0]
            : [...choosePool].sort(
                (a, b) =>
                  (slotLoad.get(a.gi) ?? 0) - (slotLoad.get(b.gi) ?? 0) ||
                  a.gi - b.gi,
              )[0]
          addBlock(years[target.yearIdx].id, target.termIdx, code)
          codeSlot.set(code, target.gi)
          slotLoad.set(target.gi, (slotLoad.get(target.gi) ?? 0) + 1)
          placed++
        }
      }
      if (placed > 0) playSfx('autofillDone')
    } finally {
      setFilling(false)
    }
  }

  const btnClass =
    'flex items-center gap-1.5 rounded border border-line bg-surface-raised px-3 py-1.5 text-xs text-fg-muted hover:bg-surface hover:text-fg transition-colors text-left'

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg">Actions</h3>
      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" onClick={() => { playSfx('click'); onClearAll() }} className={btnClass}>
          <TrashIcon className="w-3.5 h-3.5 text-accent" />
          <span>Clear All</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setIgnoreOpen((o) => !o)
            playSfx(ignoreOpen ? 'collapse' : 'expand')
          }}
          className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs transition-colors text-left ${
            ignoreOpen
              ? 'border-fg-faint bg-surface text-fg'
              : 'border-line bg-surface-raised text-fg-muted hover:bg-surface hover:text-fg'
          }`}
        >
          <EyeOffIcon className="w-3.5 h-3.5 text-accent" />
          <span>Ignore Error</span>
        </button>
        <button
          type="button"
          onClick={() => { playSfx('click'); handleAutofill() }}
          disabled={filling}
          className={`${btnClass} disabled:opacity-50`}
        >
          <SparklesIcon className="w-3.5 h-3.5 text-accent" />
          <span>{filling ? 'Filling…' : 'Autofill'}</span>
        </button>
        <button type="button" className={btnClass}>
          <ChatIcon className="w-3.5 h-3.5 text-accent" />
          <span>Ask AI</span>
        </button>
      </div>
      {ignoreOpen && (
        <div className="rounded border border-line bg-surface p-2 flex flex-col gap-1">
          {erroredBlocks.length === 0 ? (
            <p className="text-xs text-fg-faint italic">No errors to ignore</p>
          ) : (
            erroredBlocks.map((block) => (
              <label
                key={block.id}
                className="flex items-center gap-2 text-xs cursor-pointer hover:bg-surface-raised rounded px-1 py-0.5"
              >
                <input
                  type="checkbox"
                  checked={ignoredSet.has(block.id)}
                  onChange={() => {
                    toggleIgnoreBlock(block.id)
                    playSfx(ignoredSet.has(block.id) ? 'toggleOff' : 'toggleOn')
                  }}
                  className="accent-accent"
                />
                <span className="font-mono text-fg">{block.code}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// Drop targets come in two shapes: explicit term droppables (id pattern
// `term:${yearId}:${termIdx}`) and sortable course blocks within a term
// (id pattern `block:${blockId}`). When the user drops on a block,
// resolve the (year, term, position) of *that block* so the new item
// inserts just before it.
function resolveTermDrop(
  overId: string,
  years: Year[],
): { yearId: string; termIdx: number; pos: number } | null {
  if (overId.startsWith(TERM_PREFIX)) {
    const rest = overId.slice(TERM_PREFIX.length)
    const sep = rest.lastIndexOf(':')
    if (sep === -1) return null
    const yearId = rest.slice(0, sep)
    const termIdx = Number(rest.slice(sep + 1))
    if (Number.isNaN(termIdx)) return null
    return { yearId, termIdx, pos: -1 }
  }
  if (overId.startsWith('block:')) {
    const blockId = overId.slice('block:'.length)
    for (const year of years) {
      for (let ti = 0; ti < year.terms.length; ti++) {
        const pos = year.terms[ti].blocks.findIndex((b) => b.id === blockId)
        if (pos !== -1) return { yearId: year.id, termIdx: ti, pos }
      }
    }
  }
  return null
}

