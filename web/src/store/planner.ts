// Persisted state for the Degree Planner page. Mirrors the conversations
// store pattern (zustand + persist middleware → localStorage key
// 'ubcllm-planner'). Persists everything the user has assembled — year
// columns, term layouts, block ids/codes, faculty/major/minor selection —
// so a refresh restores the plan in place.
//
// Course metadata (title, credits) is NOT persisted; the planner re-resolves
// each block's code against `getCourseIndex()` at render time so corpus
// updates flow through to existing plans.
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type TermSeason = 'fall' | 'spring' | 'summer'
// Default 2-term year = Term 1 (Sep-Dec) + Term 2 (Jan-Apr). The third
// slot is Summer (May-Aug); only present when the user bumps a column to
// 3 terms.
const SEASON_ORDER: TermSeason[] = ['fall', 'spring', 'summer']

export interface PlannedBlock {
  id: string
  code: string
}

export interface Term {
  season: TermSeason
  blocks: PlannedBlock[]
}

export interface Year {
  id: string
  label: string
  terms: Term[]
}

export type PlannerSidebarTab = 'preferences' | 'progress' | 'courses'

interface PlannerState {
  years: Year[]
  // Single global term count applied to every year column. Lives in the
  // store (not derived from years[0].terms.length) so the persisted value
  // survives a year-count change that would otherwise drop the signal.
  termsPerYear: number
  // Preferred courses per term — a soft target used only by the autofill
  // scheduler to balance the spread. Manual drag-in ignores it entirely.
  preferredCoursesPerTerm: number
  faculty: string | null
  major: string | null
  minor: string | null
  sidebarCollapsed: boolean
  sidebarTab: PlannerSidebarTab
  // Block IDs whose prereq/coreq errors the user chose to suppress.
  ignoredBlocks: string[]
  // Program-requirement rows the user manually ticked (transfer credit, AP,
  // courses they won't place on the board). Keyed per program so switching
  // majors doesn't carry checks across. See toggleRequirement.
  checkedRequirements: string[]

  setYearCount: (n: number) => void
  setTermsPerYear: (n: number) => void
  setPreferredCoursesPerTerm: (n: number) => void
  addBlock: (yearId: string, termIdx: number, code: string) => void
  moveBlock: (
    blockId: string,
    toYearId: string,
    toTermIdx: number,
    toPos: number,
  ) => void
  removeBlock: (blockId: string) => void
  clearAllBlocks: () => void
  toggleIgnoreBlock: (blockId: string) => void
  toggleRequirement: (key: string) => void
  setProgram: (
    level: 'faculty' | 'major' | 'minor',
    value: string | null,
  ) => void
  setSidebarTab: (tab: PlannerSidebarTab) => void
  toggleSidebar: () => void
}

export const MIN_YEARS = 3
export const MAX_YEARS = 6
export const MIN_TERMS = 1
export const MAX_TERMS = 3
export const DEFAULT_YEARS = 4
export const DEFAULT_TERMS = 2
// Preferred per-term course load. A soft target the autofill scheduler aims
// for when spreading courses; drag-in is NOT constrained by it (the user can
// stack a term as high as they like by hand).
export const MIN_PREFERRED_PER_TERM = 3
export const MAX_PREFERRED_PER_TERM = 10
export const DEFAULT_PREFERRED_PER_TERM = 5

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2)
}

function buildYear(index: number, termCount: number): Year {
  return {
    id: newId(),
    label: `Year ${index + 1}`,
    terms: SEASON_ORDER.slice(0, termCount).map((season) => ({
      season,
      blocks: [],
    })),
  }
}

function initialYears(): Year[] {
  return Array.from({ length: DEFAULT_YEARS }, (_, i) =>
    buildYear(i, DEFAULT_TERMS),
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

// Walk every term and remove the block with the given id. Returns the
// mutated years array (new object identity) so React re-renders.
function removeBlockEverywhere(years: Year[], blockId: string): Year[] {
  return years.map((y) => ({
    ...y,
    terms: y.terms.map((t) => ({
      ...t,
      blocks: t.blocks.filter((b) => b.id !== blockId),
    })),
  }))
}

export const usePlanner = create<PlannerState>()(
  persist(
    (set) => ({
      years: initialYears(),
      termsPerYear: DEFAULT_TERMS,
      preferredCoursesPerTerm: DEFAULT_PREFERRED_PER_TERM,
      faculty: null,
      major: null,
      minor: null,
      sidebarCollapsed: false,
      sidebarTab: 'preferences',
      ignoredBlocks: [],
      checkedRequirements: [],

      setYearCount: (n) =>
        set((s) => {
          const target = clamp(n, MIN_YEARS, MAX_YEARS)
          const current = s.years.length
          if (target === current) return s
          if (target > current) {
            const extra = Array.from({ length: target - current }, (_, i) =>
              buildYear(current + i, s.termsPerYear),
            )
            return { years: [...s.years, ...extra] }
          }
          // Shrinking: trim from the tail. Blocks in removed years are
          // dropped silently — the planner shows a confirm before calling
          // this, so by the time we get here the user has agreed.
          return { years: s.years.slice(0, target) }
        }),

      setTermsPerYear: (n) =>
        set((s) => {
          const target = clamp(n, MIN_TERMS, MAX_TERMS)
          if (target === s.termsPerYear) return s
          const years = s.years.map((y) => {
            const current = y.terms.length
            if (target === current) return y
            if (target > current) {
              const extra = SEASON_ORDER.slice(current, target).map(
                (season) => ({ season, blocks: [] as PlannedBlock[] }),
              )
              return { ...y, terms: [...y.terms, ...extra] }
            }
            // Shrink — blocks in dropped terms are discarded. The UI
            // confirms first when the change would lose data, so by the
            // time we land here the user has agreed.
            return { ...y, terms: y.terms.slice(0, target) }
          })
          return { years, termsPerYear: target }
        }),

      setPreferredCoursesPerTerm: (n) =>
        set(() => ({
          preferredCoursesPerTerm: clamp(
            n,
            MIN_PREFERRED_PER_TERM,
            MAX_PREFERRED_PER_TERM,
          ),
        })),

      addBlock: (yearId, termIdx, code) =>
        set((s) => {
          const block: PlannedBlock = { id: newId(), code }
          const years = s.years.map((y) => {
            if (y.id !== yearId) return y
            const terms = y.terms.map((t, i) =>
              i === termIdx ? { ...t, blocks: [...t.blocks, block] } : t,
            )
            return { ...y, terms }
          })
          return { years }
        }),

      moveBlock: (blockId, toYearId, toTermIdx, toPos) =>
        set((s) => {
          let moved: PlannedBlock | null = null
          // First pass: pluck the block. Track the source so we know
          // whether to insert at `toPos` or `toPos - 1` (a within-term
          // move shifts the index when we remove before re-inserting).
          let sourceYearId: string | null = null
          let sourceTermIdx = -1
          let sourcePos = -1
          for (const y of s.years) {
            for (let ti = 0; ti < y.terms.length; ti++) {
              const idx = y.terms[ti].blocks.findIndex((b) => b.id === blockId)
              if (idx !== -1) {
                moved = y.terms[ti].blocks[idx]
                sourceYearId = y.id
                sourceTermIdx = ti
                sourcePos = idx
                break
              }
            }
            if (moved) break
          }
          if (!moved) return s

          const years = s.years.map((y) => ({
            ...y,
            terms: y.terms.map((t) => ({
              ...t,
              blocks: t.blocks.filter((b) => b.id !== blockId),
            })),
          }))

          // Index adjustment for same-term reorders: removing from `sourcePos`
          // before re-inserting shifts every later position down by one.
          let insertAt = toPos
          if (
            sourceYearId === toYearId &&
            sourceTermIdx === toTermIdx &&
            sourcePos < toPos
          ) {
            insertAt = toPos - 1
          }

          const next = years.map((y) => {
            if (y.id !== toYearId) return y
            const terms = y.terms.map((t, i) => {
              if (i !== toTermIdx) return t
              const blocks = [...t.blocks]
              const clamped = clamp(insertAt, 0, blocks.length)
              blocks.splice(clamped, 0, moved!)
              return { ...t, blocks }
            })
            return { ...y, terms }
          })
          return { years: next }
        }),

      removeBlock: (blockId) =>
        set((s) => ({
          years: removeBlockEverywhere(s.years, blockId),
          ignoredBlocks: s.ignoredBlocks.filter((id) => id !== blockId),
        })),

      clearAllBlocks: () =>
        set((s) => ({
          years: s.years.map((y) => ({
            ...y,
            terms: y.terms.map((t) => ({ ...t, blocks: [] })),
          })),
          ignoredBlocks: [],
        })),

      toggleIgnoreBlock: (blockId) =>
        set((s) => ({
          ignoredBlocks: s.ignoredBlocks.includes(blockId)
            ? s.ignoredBlocks.filter((id) => id !== blockId)
            : [...s.ignoredBlocks, blockId],
        })),

      toggleRequirement: (key) =>
        set((s) => ({
          checkedRequirements: s.checkedRequirements.includes(key)
            ? s.checkedRequirements.filter((k) => k !== key)
            : [...s.checkedRequirements, key],
        })),

      setProgram: (level, value) =>
        set(() => ({ [level]: value }) as Partial<PlannerState>),

      setSidebarTab: (tab) => set({ sidebarTab: tab }),

      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    {
      name: 'ubcllm-planner',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    },
  ),
)
