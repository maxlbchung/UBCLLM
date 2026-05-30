// Shared type for the per-block prereq/coreq evaluation result. Computed
// once per planner render in Planning.tsx (memoized) and passed down to
// each CourseBlock so the red-border + tooltip stays in sync with the
// cumulative completed-set walk.
//
// `completedBefore` / `completedSameOrBefore` carry the snapshot of taken
// courses at the moment this block was evaluated — prereqs check against
// the first, coreqs against the second. They're passed through to the
// CourseInfoPopup so it can re-evaluate the AST and highlight at clause
// granularity (the whole "either A or B" if all branches are unmet, only
// the unmet half of "A and B", and so on).

export interface BlockValidation {
  ok: boolean
  missing: string[]
  completedBefore: Set<string>
  completedSameOrBefore: Set<string>
}

// Neutral fallback for rare cases where a block id isn't in the
// validations map yet (e.g. the drag overlay racing the recompute).
// Empty completed sets cause the popup to render prereqs/coreqs without
// highlighting — safer than crashing.
export const EMPTY_VALIDATION: BlockValidation = {
  ok: true,
  missing: [],
  completedBefore: new Set(),
  completedSameOrBefore: new Set(),
}
