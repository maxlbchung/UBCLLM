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
  RedoIcon,
  SparklesIcon,
  TrashIcon,
  UndoIcon,
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
  const undo = usePlanner((s) => s.undo)
  const redo = usePlanner((s) => s.redo)

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

  // Keyboard shortcuts for the planner page: Ctrl/Cmd+Z undoes, Ctrl/Cmd+
  // Shift+Z and Ctrl+Y redo. Skipped while a text field is focused so we
  // don't hijack native editing in the rename inputs or course search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el?.isContentEditable
      ) {
        return
      }
      e.preventDefault()
      const { past, future } = usePlanner.getState()
      if (key === 'y' || (key === 'z' && e.shiftKey)) {
        if (future.length > 0) { redo(); playSfx('redo') }
      } else if (past.length > 0) {
        undo(); playSfx('undo')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

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
  const addBlocks = usePlanner((s) => s.addBlocks)
  const preferredCoursesPerTerm = usePlanner((s) => s.preferredCoursesPerTerm)
  const toggleIgnoreBlock = usePlanner((s) => s.toggleIgnoreBlock)
  const checkedRequirements = usePlanner((s) => s.checkedRequirements)
  const undo = usePlanner((s) => s.undo)
  const redo = usePlanner((s) => s.redo)
  const canUndo = usePlanner((s) => s.past.length > 0)
  const canRedo = usePlanner((s) => s.future.length > 0)
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

  // Autofill in two passes: (1) place each required course as early as its
  // prerequisites and corequisites allow, then (2) push courses back, term by
  // term, until every term is within the preferred course load. One-of rows
  // take the first listed course, all-of rows take every course; rows already
  // fulfilled (a satisfying course planned, or a manual check), unknown codes,
  // and anything already in the plan are skipped.
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
      // Existing blocks are fixed anchors — autofill never moves what the user
      // placed by hand; it only schedules the courses it adds.
      const planned = new Set(plannedCodes)

      // 1) Gather the courses to place — a flat list in requirement order
      //    (lower years first, a natural tiebreaker for "as early as
      //    possible"). One-of → first listed course; all-of → every course.
      //    Skip rows already fulfilled / manually checked, unknown codes, and
      //    anything already in the plan.
      const toPlace: string[] = []
      const willPlace = new Set<string>()
      for (const pyear of parsed.years) {
        for (const item of pyear.items) {
          if (item.kind !== 'course') continue
          const key = requirementKey(req.program_url, pyear.label, item)
          if (isRequirementMet(item, planned) || checked.has(key)) continue
          const chosen =
            item.mode === 'oneof' ? item.codes.slice(0, 1) : item.codes
          for (const code of chosen) {
            if (!courseIndex.has(code)) continue
            if (planned.has(code) || willPlace.has(code)) continue
            willPlace.add(code)
            toPlace.push(code)
          }
        }
      }
      if (toPlace.length === 0) {
        window.alert('All requirements are already in the plan or fulfilled.')
        return
      }

      // Every code that will live in the plan once we're done. Only courses
      // actually present can constrain ordering, so prereq/coreq edges below
      // are filtered to this set.
      const planSet = new Set([...planned, ...willPlace])

      // Every code referenced anywhere in a parsed requirement expression.
      // Used (filtered to the plan) to wire up the push-back safety map.
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
      const prereqAstOf = (code: string): Expr | null => {
        const chunk = courseIndex.get(code)
        return chunk ? parsePrereq(parseCourseChunk(chunk).prerequisites) : null
      }
      const coreqAstOf = (code: string): Expr | null => {
        const chunk = courseIndex.get(code)
        return chunk ? parsePrereq(parseCourseChunk(chunk).corequisites) : null
      }

      // Linear list of (year, term) slots in chronological order, and where
      // each course currently sits. Existing blocks seed `slot` as anchors.
      const slotOf: { yearIdx: number; termIdx: number }[] = []
      const slot = new Map<string, number>()
      years.forEach((year, y) =>
        year.terms.forEach((term, t) => {
          const gi = slotOf.length
          slotOf.push({ yearIdx: y, termIdx: t })
          for (const b of term.blocks) slot.set(b.code, gi)
        }),
      )
      const lastSlot = slotOf.length - 1
      if (lastSlot < 0) return

      // 2) PLACE AS EARLY AS POSSIBLE. To order a course we walk its prereq /
      //    coreq AST and ask: by which term does the *plan* satisfy it? An AND
      //    needs its latest child; an OR (an "either A, B, C") needs only its
      //    EARLIEST satisfiable branch — so a big "or" never floats a course to
      //    term 0 just because two of its options happen to both be planned,
      //    and never forces it after options it doesn't need. Branches the plan
      //    can't satisfy (a code not planned) and prose conditions ("third-year
      //    standing") impose no ordering. `reqSlot` returns that term, or null
      //    when nothing in the plan constrains it. Memoised + cycle-safe; an
      //    existing anchor reports its fixed slot.
      const earliestMemo = new Map<string, number>()
      function reqSlot(e: Expr | null, stack: Set<string>): number | null {
        if (!e) return null
        switch (e.kind) {
          case 'code':
            return planSet.has(e.code) ? earliest(e.code, stack) : null
          case 'and': {
            // Need every evaluable conjunct; satisfied at the latest of them.
            // A required conjunct the plan lacks can't be satisfied → no
            // ordering (null) rather than an invented chain.
            let max = -1
            for (const c of e.children) {
              if (c.kind === 'literal' || c.kind === 'soft') continue
              const s = reqSlot(c, stack)
              if (s === null) return null
              max = Math.max(max, s)
            }
            return max < 0 ? null : max
          }
          case 'or': {
            // Any one branch suffices — constrain by the earliest satisfiable.
            let min = Infinity
            for (const c of e.children) {
              const s = reqSlot(c, stack)
              if (s !== null) min = Math.min(min, s)
            }
            return min === Infinity ? null : min
          }
          case 'flattened':
            return reqSlot(e.subExpr, stack)
          case 'soft':
          case 'literal':
            return null
        }
      }
      function earliest(code: string, stack = new Set<string>()): number {
        if (slot.has(code) && !willPlace.has(code)) return slot.get(code)!
        const cached = earliestMemo.get(code)
        if (cached != null) return cached
        if (stack.has(code)) return 0
        stack.add(code)
        let e = 0
        const pre = reqSlot(prereqAstOf(code), stack)
        if (pre !== null) e = Math.max(e, pre + 1) // prereqs finish earlier
        const co = reqSlot(coreqAstOf(code), stack)
        if (co !== null) e = Math.max(e, co) // coreqs may share the term
        stack.delete(code)
        e = Math.min(e, lastSlot)
        earliestMemo.set(code, e)
        return e
      }
      for (const code of toPlace) slot.set(code, earliest(code))

      // Per-term course count, plus a reverse dependency map so the push-back
      // pass never moves a course onto — or past — something that might need it
      // first (existing blocks included). We treat any in-plan code a course
      // references as a potential edge: conservative, so a push is only ever
      // wrongly blocked (term left a touch heavy), never wrongly allowed.
      const load: number[] = slotOf.map(() => 0)
      for (const gi of slot.values()) load[gi]++
      const dependents = new Map<
        string,
        { code: string; type: 'pre' | 'co' }[]
      >()
      const addDep = (dep: string, code: string, type: 'pre' | 'co') => {
        const arr = dependents.get(dep) ?? []
        arr.push({ code, type })
        dependents.set(dep, arr)
      }
      for (const code of planSet) {
        for (const p of astCodes(prereqAstOf(code)))
          if (planSet.has(p)) addDep(p, code, 'pre')
        for (const q of astCodes(coreqAstOf(code)))
          if (planSet.has(q)) addDep(q, code, 'co')
      }
      // Moving `code` into slot `toGi` is safe only while every dependent still
      // lands later (prereq) or no earlier (coreq).
      const canPush = (code: string, toGi: number): boolean => {
        for (const d of dependents.get(code) ?? []) {
          const dGi = slot.get(d.code)
          if (dGi == null) continue
          if (d.type === 'pre' && dGi <= toGi) return false
          if (d.type === 'co' && dGi < toGi) return false
        }
        return true
      }

      // 3) PUSH BACK TO MEET THE LIMIT. Sweep terms earliest → latest; while a
      //    term is over the preferred load, push one course we added into the
      //    next term (never a user-placed block), choosing one that can move
      //    without breaking an order and has the fewest dependents (keep the
      //    heavily-depended-on courses early). Repeat the sweep because moving
      //    a dependent course later can open room for its prerequisite on an
      //    earlier term. The limit is a soft target: if nothing can move, the
      //    term is left a little heavy rather than dropping a required course.
      let pushed = true
      while (pushed) {
        pushed = false
        for (let gi = 0; gi < lastSlot; gi++) {
          while (load[gi] > preferredCoursesPerTerm) {
            const movable = toPlace
              .filter((c) => slot.get(c) === gi && canPush(c, gi + 1))
              .sort(
                (a, b) =>
                  (dependents.get(a)?.length ?? 0) -
                    (dependents.get(b)?.length ?? 0) || a.localeCompare(b),
              )
            if (movable.length === 0) break
            const c = movable[0]
            slot.set(c, gi + 1)
            load[gi]--
            load[gi + 1]++
            pushed = true
          }
        }
      }

      // Insert as one batch so the whole autofill is a single undo step.
      addBlocks(
        toPlace.map((code) => {
          const { yearIdx, termIdx } = slotOf[slot.get(code)!]
          return { yearId: years[yearIdx].id, termIdx, code }
        }),
      )
      playSfx('autofillDone')
    } finally {
      setFilling(false)
    }
  }

  const btnClass =
    'flex items-center gap-1.5 rounded border border-line bg-surface-raised px-3 py-1.5 text-xs text-fg-muted hover:bg-surface hover:text-fg transition-colors text-left'
  // Undo/Redo reuse btnClass but dim + lock when their stack is empty.
  const disabledBtnClass = `${btnClass} disabled:opacity-40 disabled:hover:bg-surface-raised disabled:hover:text-fg-muted`

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg">Actions</h3>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={() => { undo(); playSfx('undo') }}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          className={disabledBtnClass}
        >
          <UndoIcon className="w-3.5 h-3.5 text-accent" />
          <span>Undo</span>
        </button>
        <button
          type="button"
          onClick={() => { redo(); playSfx('redo') }}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
          className={disabledBtnClass}
        >
          <RedoIcon className="w-3.5 h-3.5 text-accent" />
          <span>Redo</span>
        </button>
      </div>
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
