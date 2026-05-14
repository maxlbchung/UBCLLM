import type { CSSProperties } from 'react'
import { useSettings, type Theme } from '../store/settings'
import { playSfx } from '../lib/sfx'

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark (default)' },
  { value: 'light', label: 'Light' },
  { value: 'midnight', label: 'Midnight' },
  { value: 'forest', label: 'Forest' },
  { value: 'sunset', label: 'Sunset' },
]

export function OtherPage() {
  const volume = useSettings((s) => s.volume)
  const setVolume = useSettings((s) => s.setVolume)
  const sfxEnabled = useSettings((s) => s.sfxEnabled)
  const setSfxEnabled = useSettings((s) => s.setSfxEnabled)
  const botNoisesEnabled = useSettings((s) => s.botNoisesEnabled)
  const setBotNoisesEnabled = useSettings((s) => s.setBotNoisesEnabled)
  const musicEnabled = useSettings((s) => s.musicEnabled)
  const setMusicEnabled = useSettings((s) => s.setMusicEnabled)
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)

  // Fill ends at the thumb's current snap position (so the blue runs
  // *up to the handle*, not to a percentage of the bar). 0 and 100 are
  // hard-snapped to no-fill / full-fill respectively — the user wants
  // the bar fully unfilled at min and fully filled at max even though
  // the thumb itself still has the 4 px edge inset there.
  //
  // For 0 < v < 100, thumb center in wrapper coords =
  //   11px + (v/100) * (W - 22px)
  // where W is the wrapper's current width. We can't read W at CSS
  // build time, but `calc()` does the mix-percent-and-px math at paint
  // time, so the gradient stop tracks the layout responsively.
  const fillEnd =
    volume === 0
      ? '0px'
      : volume === 100
        ? '100%'
        : `calc(11px + ${volume / 100} * (100% - 22px))`
  const barStyle = {
    background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${fillEnd}, #27272a ${fillEnd}, #27272a 100%)`,
  } as CSSProperties

  return (
    <div className="flex flex-col h-screen p-6 gap-8 max-w-3xl mx-auto w-full min-h-0 overflow-y-auto">
      <header>
        <h2 className="text-xl font-semibold">Other</h2>
      </header>

      <section className="flex flex-col gap-4 w-72 bg-zinc-900/40 border border-zinc-800 rounded-md p-5">
        <h3 className="text-xs uppercase tracking-wide text-zinc-500">Audio</h3>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label htmlFor="settings-volume" className="text-sm text-zinc-200">
              Volume
            </label>
            <span className="text-sm text-zinc-500 tabular-nums font-mono">
              {volume}
            </span>
          </div>
          <div
            className="relative w-full h-[22px] rounded-full px-[11px]"
            style={barStyle}
          >
            <input
              id="settings-volume"
              type="range"
              min={0}
              max={100}
              step={10}
              value={volume}
              onChange={(e) => {
                const next = Number(e.target.value)
                if (next === volume) return
                // Update the store BEFORE the chirp so playSfx, which reads
                // the volume from useSettings.getState(), picks up the new
                // value — otherwise the tick plays at the previous level.
                setVolume(next)
                playSfx('tick', 40)
              }}
              className="range-themed block w-full h-full m-0"
            />
            {/* Tick overlay at each 10-increment. `px-[11px]` matches the
                wrapper padding so the first/last tick land exactly where
                the thumb stops at value 0 / 100 (and every step in
                between via justify-between). `pointer-events-none` keeps
                the slider fully interactive underneath. */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-[11px]">
              {Array.from({ length: 11 }, (_, i) => (
                <span
                  key={i}
                  aria-hidden
                  className="block w-px h-2 bg-white/40 rounded-full"
                />
              ))}
            </div>
          </div>
        </div>

        <ThemedToggle
          id="settings-sfx"
          label="Sound effects"
          checked={sfxEnabled}
          onChange={setSfxEnabled}
        />
        <ThemedToggle
          id="settings-bot-noises"
          label="High-tech bot noises"
          checked={botNoisesEnabled}
          onChange={setBotNoisesEnabled}
        />
        <ThemedToggle
          id="settings-music"
          label="Music"
          checked={musicEnabled}
          onChange={setMusicEnabled}
        />
      </section>

      <section className="flex flex-col gap-4 w-72 bg-zinc-900/40 border border-zinc-800 rounded-md p-5">
        <h3 className="text-xs uppercase tracking-wide text-zinc-500">
          Visuals
        </h3>
        <div className="flex items-center justify-between">
          <label htmlFor="settings-theme" className="text-sm text-zinc-200">
            Theme
          </label>
          <select
            id="settings-theme"
            value={theme}
            // mousedown fires before the native dropdown popup appears,
            // which is the closest cross-browser hook for "opening". A
            // re-click that closes the popup also fires mousedown — we
            // accept the duplicate chirp on that edge rather than
            // tracking open state manually.
            onMouseDown={() => playSfx('dropdownOpen')}
            onChange={(e) => {
              playSfx('click')
              setTheme(e.target.value as Theme)
            }}
            className="bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 px-2 py-1 focus:outline-none focus:border-zinc-500"
          >
            {THEME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="mt-auto pt-6 border-t border-zinc-800">
        <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">
          About
        </h3>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Created summer of 2026 by Max Libo Chung using Claude Opus 4.7<br></br>
          Qwen3.5 2B · WebGPU · MiniLM embeddings · UBC Vancouver calendar
          2026/27.
        </p>
      </section>
    </div>
  )
}

// Pill-shaped switch sized to match the volume slider: same 22 px track
// height, same 14 px zinc-100 thumb with the soft drop shadow, same
// blue-500 fill when on. The thumb slides between left:4 / left:22 — the
// 22 figure is track-width (40) − thumb-width (14) − inset (4).
function ThemedToggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <label htmlFor={id} className="text-sm text-zinc-200">
        {label}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => {
          // Play the click that reflects the *new* state. If we're
          // turning on, the brighter toggleOn click; if turning off,
          // the lower toggleOff. The on/off pair shares an envelope
          // but mirror pitch ranges (1200/600 vs 800/400) so the
          // user can hear the state direction without looking.
          playSfx(checked ? 'toggleOff' : 'toggleOn')
          onChange(!checked)
        }}
        className={
          'group relative h-[22px] w-[40px] rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 ' +
          (checked
            ? 'bg-blue-500 hover:bg-blue-400'
            : 'bg-zinc-800 hover:bg-zinc-700')
        }
      >
        <span
          aria-hidden
          className={
            'absolute top-[4px] block h-[14px] w-[14px] rounded-full bg-zinc-100 group-hover:bg-white shadow-[0_1px_3px_rgba(0,0,0,0.45)] transition-[left,background-color] duration-150 ' +
            (checked ? 'left-[22px]' : 'left-[4px]')
          }
        />
      </button>
    </div>
  )
}
