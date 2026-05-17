// User-tweakable app settings, persisted to localStorage so they survive a
// reload. `volume` is a 0–100 integer driving SFX playback in
// `lib/sfx.ts#playSfx` (divide by 100 for a gain multiplier);
// `musicVolume` is the analogous 0–100 control for the SomaFM stream in
// `lib/music.ts#useMusicPlayer`. The two are independent — adjusting
// SFX volume doesn't change music level and vice versa.
// `sfxEnabled` and `botNoisesEnabled` gate playback inside playSfx
// (sfxEnabled for general SFX, botNoisesEnabled for the bot
// thinking/typing pulses). `musicEnabled` + `musicStation` drive the
// music stream; musicEnabled defaults off because browsers block
// autoplay before a user gesture, so a persisted "on" would leave the
// toggle visually-on with silent reality after reload. `theme` drives
// the `data-theme` attribute on <html> (see App.tsx) which swaps the
// CSS variable palette defined in index.css.
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type Theme = 'dark' | 'light' | 'royal' | 'terminal'
// `zoom` scales the rem base (html font-size = 20px * zoom/100) so all
// rem-sized UI follows. Pixel-sized controls (slider thumb, borders)
// stay fixed intentionally — they're physical UI elements that
// shouldn't bloom with text. Limited to a small set so the dropdown
// presents discrete steps.
export type Zoom = 75 | 100 | 125
// Tier label kept around for the internal model-loading machinery
// (lib/llm.ts matchers, lib/retrieve.ts token-budget map). Only '2b'
// is ever loaded today — the app auto-loads Qwen3.5 2B on startup
// with no user choice. The union retains '4b' / '9b' so re-enabling a
// tier later is a one-file change.
export type ModelSize = '2b' | '4b' | '9b'

interface State {
  volume: number
  musicVolume: number
  sfxEnabled: boolean
  botNoisesEnabled: boolean
  musicEnabled: boolean
  musicStation: string
  theme: Theme
  zoom: Zoom
  setVolume: (v: number) => void
  setMusicVolume: (v: number) => void
  setSfxEnabled: (v: boolean) => void
  setBotNoisesEnabled: (v: boolean) => void
  setMusicEnabled: (v: boolean) => void
  setMusicStation: (s: string) => void
  setTheme: (t: Theme) => void
  setZoom: (z: Zoom) => void
}

export const useSettings = create<State>()(
  persist(
    (set) => ({
      volume: 80,
      musicVolume: 80,
      sfxEnabled: true,
      botNoisesEnabled: true,
      musicEnabled: false,
      musicStation: 'groovesalad',
      theme: 'dark',
      zoom: 100,
      setVolume: (v) =>
        set({ volume: Math.max(0, Math.min(100, Math.round(v))) }),
      setMusicVolume: (v) =>
        set({ musicVolume: Math.max(0, Math.min(100, Math.round(v))) }),
      setSfxEnabled: (v) => set({ sfxEnabled: v }),
      setBotNoisesEnabled: (v) => set({ botNoisesEnabled: v }),
      setMusicEnabled: (v) => set({ musicEnabled: v }),
      setMusicStation: (s) => set({ musicStation: s }),
      setTheme: (t) => set({ theme: t }),
      setZoom: (z) => set({ zoom: z }),
    }),
    {
      name: 'reodite-settings',
      storage: createJSONStorage(() => localStorage),
      // v6 (v1.10.4): model picking removed — Qwen3.5 2B auto-loads on
      //   startup. Drop the persisted `model` field on rehydrate so it
      //   doesn't linger in localStorage forever.
      version: 6,
      migrate: (persistedState, _version) => {
        if (!persistedState) return persistedState as State
        const s = persistedState as Partial<State> & {
          model?: string | null
          theme?: string
          zoom?: number
        }
        const validThemes: Theme[] = ['dark', 'light', 'royal', 'terminal']
        const validZooms: Zoom[] = [75, 100, 125]
        const out = { ...s } as Partial<State> & { model?: unknown }
        if (!validThemes.includes(s.theme as Theme)) {
          out.theme = 'dark'
        }
        if (!validZooms.includes(s.zoom as Zoom)) {
          out.zoom = 100
        }
        // The picker is gone — drop the persisted `model` field if any
        // older version left one behind so it doesn't linger forever.
        delete out.model
        return out as State
      },
    },
  ),
)
