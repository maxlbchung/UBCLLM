// User-tweakable app settings, persisted to localStorage so they survive a
// reload. `volume` is a 0–100 integer for slider ergonomics (divide by 100
// for a gain multiplier). `sfxEnabled` / `musicEnabled` are persisted UI
// state surfaced by toggles on OtherPage — actual gating of playback
// against them is left to consumers (e.g. sfx.ts can early-return when
// sfxEnabled is false). `theme` is a placeholder for the upcoming theming
// pass; selecting a value persists but no theme switching is wired yet.
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type Theme =
  | 'dark'
  | 'light'
  | 'midnight'
  | 'forest'
  | 'sunset'

interface State {
  volume: number
  sfxEnabled: boolean
  botNoisesEnabled: boolean
  musicEnabled: boolean
  theme: Theme
  setVolume: (v: number) => void
  setSfxEnabled: (v: boolean) => void
  setBotNoisesEnabled: (v: boolean) => void
  setMusicEnabled: (v: boolean) => void
  setTheme: (t: Theme) => void
}

export const useSettings = create<State>()(
  persist(
    (set) => ({
      volume: 80,
      sfxEnabled: true,
      botNoisesEnabled: true,
      musicEnabled: true,
      theme: 'dark',
      setVolume: (v) =>
        set({ volume: Math.max(0, Math.min(100, Math.round(v))) }),
      setSfxEnabled: (v) => set({ sfxEnabled: v }),
      setBotNoisesEnabled: (v) => set({ botNoisesEnabled: v }),
      setMusicEnabled: (v) => set({ musicEnabled: v }),
      setTheme: (t) => set({ theme: t }),
    }),
    {
      name: 'reodite-settings',
      storage: createJSONStorage(() => localStorage),
    },
  ),
)
