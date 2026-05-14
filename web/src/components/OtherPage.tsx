import { useSettings, type Theme, type Zoom } from '../store/settings'
import { playSfx } from '../lib/sfx'
import { SOMAFM_CHANNELS } from '../lib/music'

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'royal', label: 'Royal' },
  { value: 'terminal', label: 'Terminal' },
]

const ZOOM_OPTIONS: { value: Zoom; label: string }[] = [
  { value: 75, label: '75%' },
  { value: 100, label: '100%' },
  { value: 125, label: '125%' },
]

export function OtherPage() {
  const volume = useSettings((s) => s.volume)
  const setVolume = useSettings((s) => s.setVolume)
  const musicVolume = useSettings((s) => s.musicVolume)
  const setMusicVolume = useSettings((s) => s.setMusicVolume)
  const sfxEnabled = useSettings((s) => s.sfxEnabled)
  const setSfxEnabled = useSettings((s) => s.setSfxEnabled)
  const botNoisesEnabled = useSettings((s) => s.botNoisesEnabled)
  const setBotNoisesEnabled = useSettings((s) => s.setBotNoisesEnabled)
  const musicEnabled = useSettings((s) => s.musicEnabled)
  const setMusicEnabled = useSettings((s) => s.setMusicEnabled)
  const musicStation = useSettings((s) => s.musicStation)
  const setMusicStation = useSettings((s) => s.setMusicStation)
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const zoom = useSettings((s) => s.zoom)
  const setZoom = useSettings((s) => s.setZoom)

  const selectedChannel =
    SOMAFM_CHANNELS.find((c) => c.key === musicStation) ?? SOMAFM_CHANNELS[0]

  return (
    <div className="flex flex-col h-screen p-6 gap-8 max-w-3xl mx-auto w-full min-h-0 overflow-y-auto">
      <header>
        <h2 className="text-xl font-semibold">Other</h2>
      </header>

      {/* Audio + Music sit side-by-side: both are sound-related so they
          read as a pair, and each is only w-72 wide which leaves room
          on the max-w-3xl page (288 + 32 gap + 288 = 608 < 768). The
          wrapper uses items-start so the shorter section doesn't
          stretch to match the taller one. Visuals stacks directly
          under Audio Effects in the left column so it reads as a
          continuation of the SFX block rather than floating below
          the whole row. */}
      <div className="flex flex-wrap items-start gap-8">
        <div className="flex flex-col gap-4 w-72">
        <section className="flex flex-col gap-4 bg-surface-soft border border-line rounded-md p-5">
          <h3 className="text-xs uppercase tracking-wide text-fg-faint">Audio Effects</h3>

          <VolumeSlider
            id="settings-volume"
            label="SFX Volume"
            value={volume}
            onChange={setVolume}
          />

          <ThemedToggle
            id="settings-sfx"
            label="UI Sounds"
            checked={sfxEnabled}
            onChange={setSfxEnabled}
          />
          <ThemedToggle
            id="settings-bot-noises"
            label="High-tech bot noises"
            checked={botNoisesEnabled}
            onChange={setBotNoisesEnabled}
          />
        </section>

        <section className="flex flex-col gap-4 bg-surface-soft border border-line rounded-md p-5">
          <h3 className="text-xs uppercase tracking-wide text-fg-faint">
            Visuals
          </h3>
          <div className="flex items-center justify-between">
            <label htmlFor="settings-theme" className="text-sm text-fg">
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
              className="w-28 bg-input border border-line-soft rounded text-sm text-fg px-2 py-1 focus:outline-none focus:border-fg-faint"
            >
              {THEME_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between">
            <label htmlFor="settings-zoom" className="text-sm text-fg">
              Zoom
            </label>
            <select
              id="settings-zoom"
              value={zoom}
              onMouseDown={() => playSfx('dropdownOpen')}
              onChange={(e) => {
                playSfx('click')
                setZoom(Number(e.target.value) as Zoom)
              }}
              className="w-28 bg-input border border-line-soft rounded text-sm text-fg px-2 py-1 focus:outline-none focus:border-fg-faint"
            >
              {ZOOM_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </section>
        </div>

        <section className="flex flex-col gap-4 w-72 bg-surface-soft border border-line rounded-md p-5">
          <h3 className="text-xs uppercase tracking-wide text-fg-faint">Music</h3>

          <VolumeSlider
            id="settings-music-volume"
            label="Music Volume"
            value={musicVolume}
            onChange={setMusicVolume}
          />

          <ThemedToggle
            id="settings-music"
            label="Play"
            checked={musicEnabled}
            onChange={setMusicEnabled}
          />

          {/* Station picker — faded and inert until Play is on. We pair
              `disabled` on the <select> (keyboard / screen-reader
              semantics) with opacity + pointer-events-none on the
              wrapper (visual + mouse). The toggle stays interactive
              above; only the station controls are gated. */}
          <div
            className={
              'flex flex-col gap-1.5 transition-opacity duration-150 ' +
              (musicEnabled ? '' : 'opacity-50 pointer-events-none')
            }
            aria-disabled={!musicEnabled}
          >
            <div className="flex items-center justify-between">
              <label
                htmlFor="settings-music-station"
                className="text-sm text-fg"
              >
                Station
              </label>
              <select
                id="settings-music-station"
                value={musicStation}
                disabled={!musicEnabled}
                // mousedown fires before the native popup opens; matches
                // the theme dropdown pattern. We accept the duplicate
                // chirp on a re-click-to-close edge rather than tracking
                // open state manually.
                onMouseDown={() => playSfx('dropdownOpen')}
                onChange={(e) => {
                  playSfx('click')
                  setMusicStation(e.target.value)
                }}
                className="bg-input border border-line-soft rounded text-sm text-fg px-2 py-1 focus:outline-none focus:border-fg-faint disabled:cursor-not-allowed"
              >
                {SOMAFM_CHANNELS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-fg-muted leading-relaxed text-right">
              {selectedChannel.tagline}
            </p>
          </div>

          {/* SomaFM's terms require third-party players to display the
            station name (covered by the dropdown above) and a
            click-through link to somafm.com. Keep this paragraph wired
            up if you redesign the section. `-mt-3` pulls it up out of
            the section's gap-4 so it nestles right under the station
            description instead of floating on its own row. */}
          <p className="text-[0.625rem] text-fg-faint leading-relaxed text-right -mt-3">
            Streaming from{' '}
            <a
              href="https://somafm.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-link hover:underline"
            >
              SomaFM
            </a>{' '}
          </p>
        </section>
      </div>

      <section className="mt-auto pt-6 border-t border-line">
        <h3 className="text-xs uppercase tracking-wide text-fg-faint mb-2">
          About
        </h3>
        <p className="text-xs text-fg-muted leading-relaxed">
          Created summer of 2026 by Max Libo Chung using Claude Opus 4.7<br></br>
          Qwen3.5 2B · WebGPU · MiniLM embeddings · UBC Vancouver calendar
          2026/27.
        </p>
        <p className="mt-3 text-xs text-fg-muted leading-relaxed">
          © 2026 Max Libo Chung. Source code under{' '}
          <a
            href="https://github.com/maxlbchung/UBCLLM/blob/master/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            className="text-link hover:underline"
          >
            PolyForm Noncommercial 1.0.0
          </a>
          {' '}— no commercial use without permission. Course content ©{' '}
          <a
            href="https://vancouver.calendar.ubc.ca/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-link hover:underline"
          >
            UBC
          </a>
          . Model and library credits:{' '}
          <a
            href="https://github.com/maxlbchung/UBCLLM/blob/master/NOTICE"
            target="_blank"
            rel="noopener noreferrer"
            className="text-link hover:underline"
          >
            NOTICE
          </a>
          .
        </p>
      </section>
    </div>
  )
}

// Themed 0–100 slider with the rounded-pill track + tick row pattern.
// Used twice on this page — once for SFX volume, once for music volume —
// each instance wired to its own settings field. The visible track lives
// on the outer wrapper (bg-surface-raised), the blue fill is a separate
// rounded-full div sized via calc(), and the native <input type=range>
// thumb floats on top with the styling defined in index.css under
// `.range-themed`. Sliding plays a throttled `tick` chirp; the chirp
// uses the SFX volume from the store regardless of which slider is
// being moved, so the music slider's tick stays at SFX level (not
// silent when music volume is dragged to 0).
function VolumeSlider({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: number
  onChange: (v: number) => void
}) {
  // Width of the accent-colored fill pill. The fill extends to 4 px
  // past the thumb's right edge so the thumb visually sits inside the
  // pill at every value. For 0 < v < 100:
  //   thumb center  = 11px + (v/100) * (W - 22px)   (W = wrapper width)
  //   thumb right   = center + 7  = 18 + (v/100) * (W - 22)
  //   fill end      = thumb right + 4 = 22 + (v/100) * (W - 22)
  // calc() does the mix-percent-and-px math at paint time. 0 / 100
  // hard-snap to no-fill / full-fill so the bar reads as empty at min
  // and brimming at max even though the thumb still has its 4 px edge
  // inset there.
  const fillWidth =
    value === 0
      ? '0px'
      : value === 100
        ? '100%'
        : `calc(22px + ${value / 100} * (100% - 22px))`
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm text-fg">
          {label}
        </label>
        <span className="text-sm text-fg-faint tabular-nums font-mono">
          {value}
        </span>
      </div>
      <div className="relative w-full h-[22px] rounded-full bg-surface-raised px-[4px]">
        {/* Fill pill — rounded both ends so the right edge curves like
            a toggle track instead of clipping flat. Sits below the
            input + tick overlay in DOM order so those still receive
            pointer events and paint on top. */}
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 rounded-full bg-accent pointer-events-none"
          style={{ width: fillWidth }}
        />
        {/* Tick overlay at each 10-increment. `px-[11px]` lines the
            first/last tick up with the thumb centers at value 0 / 100.
            Tick color flips with the fill state: ticks past the fill
            front stay accent (visible against the surface-raised
            track); ticks under the fill switch to accent-fg so they
            read as faint white pips against the blue (otherwise
            they'd vanish into the same accent color as the fill).
            pointer-events-none keeps the slider interactive underneath. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-[11px]">
          {Array.from({ length: 11 }, (_, i) => {
            const tickValue = i * 10
            // v=0 hard-snaps to no fill, so even tick 0 stays uncovered;
            // otherwise every tick at or below the current value is
            // under the fill.
            const covered = value > 0 && tickValue <= value
            return (
              <span
                key={i}
                aria-hidden
                className={
                  'block w-px h-2 rounded-full ' +
                  (covered ? 'bg-accent-fg' : 'bg-fg-muted')
                }
              />
            )
          })}
        </div>
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={10}
          value={value}
          onChange={(e) => {
            const next = Number(e.target.value)
            if (next === value) return
            // Update the store BEFORE the chirp so playSfx, which reads
            // SFX volume from useSettings.getState(), picks up the new
            // value when the slider being moved IS the SFX slider —
            // otherwise the tick chirps at the previous level. For the
            // music slider this is a no-op (the chirp reads SFX volume,
            // which didn't change) but the order is harmless.
            onChange(next)
            playSfx('tick', 40)
          }}
          className="range-themed relative block w-full h-full m-0"
        />
      </div>
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
      <label htmlFor={id} className="text-sm text-fg">
        {label}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => {
          // Update the store BEFORE the chirp so playSfx sees the new
          // state. Matters specifically for the SFX master toggle: when
          // you turn it off, the off-chirp gates to silence (matches the
          // new "audio is off" state); when you turn it on, the on-chirp
          // plays at the just-enabled level. For the other audio toggles
          // (bot noises, music) the order is irrelevant since sfxEnabled
          // isn't changing. The on/off pair shares an envelope but
          // mirrors pitch ranges (1200/600 vs 800/400) so the direction
          // reads even without looking.
          onChange(!checked)
          playSfx(checked ? 'toggleOff' : 'toggleOn')
        }}
        className={
          'group relative h-[22px] w-[40px] rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 ' +
          (checked
            ? 'bg-accent hover:bg-accent-hover'
            : 'bg-surface-raised hover:bg-line-soft')
        }
      >
        {/* Thumb color flips with `checked` so it stays legible in both
            themes: on the accent fill we want the accent-fg disc (white
            in both); off the accent we want a mid-grey disc so the
            light theme doesn't render an almost-black puck on a
            near-white track. fg-muted (zinc-400 dark / zinc-600 light)
            reads as dark grey in both. */}
        <span
          aria-hidden
          className={
            'absolute top-[4px] block h-[14px] w-[14px] rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.45)] transition-[left,background-color] duration-150 ' +
            (checked
              ? 'left-[22px] bg-accent-fg'
              : 'left-[4px] bg-fg-muted')
          }
        />
      </button>
    </div>
  )
}
