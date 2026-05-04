// Tracks which hand-curated easter-egg chunks the user has triggered as the
// top retrieval result. Persisted across sessions so the sidebar counter
// "N/total" carries over reloads. Total is recomputed each session from the
// live corpus (not persisted) so adding/removing eggs in the pipeline
// reflects automatically without a migration.
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { loadCorpus } from '../lib/retrieve'

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
        const validIds = chunks
          .filter((c) => c.kind === 'easter')
          .map((c) => c.id)
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
