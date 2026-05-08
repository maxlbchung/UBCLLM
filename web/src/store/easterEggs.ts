// Tracks which hand-curated easter-egg chunks the user has triggered as the
// top retrieval result. Persisted across sessions so the sidebar counter
// "N/total" carries over reloads. Total is recomputed each session from the
// live corpus (not persisted) so adding/removing eggs in the pipeline
// reflects automatically without a migration.
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { loadCorpus } from '../lib/retrieve'

// Synthetic easter IDs — eggs that don't live in the scraped corpus but
// should still count toward the discoverable pool. Most easters are hand-
// curated chunks in pipeline/easter-eggs.json (kind 'easter') and get
// triggered from Chat.tsx when they win the top retrieval slot. UI-local
// easters (no retrieval signal) need to be enumerated here so loadFromCorpus
// can include them in validIds — otherwise their markDiscovered call lands
// in `discovered` but the validIds intersection in Sidebar drops it and the
// counter never moves. Single source of truth for the ID; whichever
// component owns the easter imports the constant so the strings can't drift.
export const ABCD_EASTER_ID = 'easter:abcd-song'
// Surfaced when the user lands on the deepest possible prereq tree in the
// corpus — FNH 483 with its full 15-node CHEM-12-rooted chain expanded.
// PrereqTree.tsx triggers it after buildGraph reports the full depth so we
// don't fire on partial / truncated traversals.
export const LONGEST_PREREQ_TREE_EASTER_ID = 'easter:longest-prereq-tree'
const SYNTHETIC_EASTER_IDS: string[] = [
  ABCD_EASTER_ID,
  LONGEST_PREREQ_TREE_EASTER_ID,
]

interface State {
  // Raw discovered chunk IDs (e.g. "easter:best-astr-prof"). Persisted.
  discovered: string[]
  // Set of easter IDs in the current corpus. Populated by loadFromCorpus()
  // and used to intersect against `discovered` so a stale entry from a
  // removed egg doesn't inflate the displayed count.
  validIds: string[]
  markDiscovered: (id: string) => void
  loadFromCorpus: () => Promise<void>
}

export const useEasterEggs = create<State>()(
  persist(
    (set, get) => ({
      discovered: [],
      validIds: [],

      markDiscovered: (id) => {
        if (get().discovered.includes(id)) return
        set((s) => ({ discovered: [...s.discovered, id] }))
      },

      loadFromCorpus: async () => {
        if (get().validIds.length > 0) return
        const { chunks } = await loadCorpus()
        const corpusIds = chunks
          .filter((c) => c.kind === 'easter')
          .map((c) => c.id)
        // Dedupe in case a synthetic ID is also present in the corpus
        // (shouldn't happen, but the Set keeps things stable if it does).
        const validIds = [...new Set([...corpusIds, ...SYNTHETIC_EASTER_IDS])]
        set({ validIds })
      },
    }),
    {
      name: 'ubcllm-easter-eggs',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (s) => ({ discovered: s.discovered }),
    },
  ),
)
