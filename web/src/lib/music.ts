// SomaFM streaming radio integration. SomaFM is a listener-supported,
// commercial-free network of internet radio stations (https://somafm.com/).
// The stream URLs below were lifted from each channel's .pls playlist
// (https://somafm.com/<channel>.pls); each playlist round-robins across
// five ICE mirrors (ice2..ice6) and we pin to ice2 here. Mirror outages
// are rare; a single URL keeps the implementation simple and the failover
// chain out of browser JS.
//
// Per SomaFM's terms-of-use (https://somafm.com/legal/), third-party
// players must display the station name and a click-through link to
// somafm.com. The Music section in OtherPage carries both.
//
// Music is independent of the SFX master toggle: `sfxEnabled` gates
// UI clicks/sweeps, `botNoisesEnabled` gates bot thinking/typing pulses,
// and `musicEnabled` gates this stream. The shared `volume` slider drives
// all three categories.
import { useEffect } from 'react'
import { useSettings } from '../store/settings'

export interface SomaChannel {
  key: string
  label: string
  tagline: string
  url: string
}

// Curated subset of SomaFM's ~30-channel lineup, biased toward
// study/coding-friendly vibes. Add a row here to surface a new channel
// in the dropdown; keep labels short enough to fit the w-72 section.
export const SOMAFM_CHANNELS: SomaChannel[] = [
  {
    key: 'groovesalad',
    label: 'Groove Salad',
    tagline: 'Ambient / downtempo beats',
    url: 'https://ice2.somafm.com/groovesalad-128-mp3',
  },
  {
    key: 'dronezone',
    label: 'Drone Zone',
    tagline: 'Atmospheric textures, no beat',
    url: 'https://ice2.somafm.com/dronezone-128-mp3',
  },
  {
    key: 'lush',
    label: 'Lush',
    tagline: 'Sensuous, mellow vocals',
    url: 'https://ice2.somafm.com/lush-128-mp3',
  },
  {
    key: 'defcon',
    label: 'DEF CON Radio',
    tagline: 'Music for hackers',
    url: 'https://ice2.somafm.com/defcon-128-mp3',
  },
  {
    key: 'spacestation',
    label: 'Space Station',
    tagline: 'Spaced-out ambient electronica',
    url: 'https://ice2.somafm.com/spacestation-128-mp3',
  },
  {
    key: 'beatblender',
    label: 'Beat Blender',
    tagline: 'Deep grooves and breaks',
    url: 'https://ice2.somafm.com/beatblender-128-mp3',
  },
  {
    key: 'secretagent',
    label: 'Secret Agent',
    tagline: 'Spy-jazz lounge',
    url: 'https://ice2.somafm.com/secretagent-128-mp3',
  },
  {
    key: 'u80s',
    label: 'Underground 80s',
    tagline: 'New wave & synth-pop',
    url: 'https://ice2.somafm.com/u80s-128-mp3',
  },
]

let audioEl: HTMLAudioElement | null = null

function getAudio(): HTMLAudioElement {
  if (audioEl) return audioEl
  const el = new Audio()
  el.preload = 'none'
  // If the stream URL itself fails (bad URL, ICE mirror down, network
  // drop) the element fires `error`. Flip the toggle back off so the
  // UI matches reality instead of showing "playing" while silent. The
  // emptied-on-pause path also triggers `error` on some browsers — the
  // handler is idempotent so the duplicate is harmless.
  el.addEventListener('error', () => {
    useSettings.getState().setMusicEnabled(false)
  })
  audioEl = el
  return el
}

function findChannel(key: string): SomaChannel {
  return SOMAFM_CHANNELS.find((c) => c.key === key) ?? SOMAFM_CHANNELS[0]
}

// Music volume curve. Two reasons not to map the 0–100 slider directly
// to audioEl.volume:
//   1. Loudness mismatch with SFX. A SomaFM stream at audioEl.volume = 1
//      lands near 0 dBFS (mastered radio), while a typical SFX click
//      peaks at ~0.275 amplitude (~-11 dBFS) thanks to MASTER_GAIN +
//      per-tone `amp` in sfx.ts. Matching slider values would mean
//      music is dramatically louder than SFX. MUSIC_MAX_GAIN caps the
//      music ceiling so slider=100 sits in the same ballpark as a
//      loud SFX peak.
//   2. Perceived-loudness curve. Linear gain feels jumpy at the top
//      and useless at the bottom because the ear is logarithmic.
//      Squaring the slider value gives a more usable range — slider
//      values in the lower half cover proportionally less audible
//      change, matching how analog "audio-taper" pots have worked
//      for decades.
const MUSIC_MAX_GAIN = 0.75

function musicGain(slider: number): number {
  return MUSIC_MAX_GAIN * (slider / 100) ** 2
}

// rAF-driven volume ramp so toggling play / stop doesn't slam in or cut
// out abruptly. 600 ms feels noticeable without dragging — long enough
// that the start of a track doesn't jump-scare, short enough that
// stopping doesn't feel sluggish.
const FADE_MS = 600
let fadeRaf: number | null = null

function cancelFade(): void {
  if (fadeRaf !== null) {
    cancelAnimationFrame(fadeRaf)
    fadeRaf = null
  }
}

function fadeVolume(
  from: number,
  to: number,
  onComplete?: () => void,
): void {
  cancelFade()
  if (!audioEl) {
    onComplete?.()
    return
  }
  // Cubic curve, not linear. Perceived loudness is logarithmic
  // (~-6 dB per halving of gain), so a linear gain ramp from 1 → 0
  // stays meaningfully audible (-20 dB ≈ 0.1 gain) for ~80% of the
  // duration and then dumps the last 20% into the final few frames,
  // which the ear reads as a harsh cutoff. Cubic ease pushes the
  // audible portion forward in time:
  //   fade-out: gain = from * (1-t)^3  → near-silent by t≈0.7
  //   fade-in:  gain = to   * t^3      → near-silent until t≈0.3
  // so the actual zero-crossing at t=1 is imperceptible against the
  // ~-60 dB floor the curve sets just before it.
  const fadingOut = to < from
  const startTime = performance.now()
  const step = (now: number): void => {
    if (!audioEl) {
      fadeRaf = null
      onComplete?.()
      return
    }
    const t = Math.min(1, (now - startTime) / FADE_MS)
    const k = fadingOut ? 1 - (1 - t) ** 3 : t ** 3
    audioEl.volume = from + (to - from) * k
    if (t >= 1) {
      fadeRaf = null
      onComplete?.()
      return
    }
    fadeRaf = requestAnimationFrame(step)
  }
  fadeRaf = requestAnimationFrame(step)
}

// Drives a single module-scoped <audio> element from the persisted music
// settings. Mounted once at the Shell level so the stream survives view
// changes — the user can leave Groove Salad running while bouncing
// between chat, lookup, and prereq panels.
//
// Browsers block autoplay before a user gesture. If a play() attempt is
// rejected (rehydrated `musicEnabled: true` after a full page reload, or
// any other no-gesture path) we flip the toggle back off so the visible
// state matches.
export function useMusicPlayer(): void {
  const enabled = useSettings((s) => s.musicEnabled)
  const station = useSettings((s) => s.musicStation)
  const volume = useSettings((s) => s.musicVolume)

  useEffect(() => {
    if (!enabled) {
      if (!audioEl) return
      // Fade out from current volume, then release the stream. The
      // toggle is re-checked inside onComplete: if the user
      // re-enabled mid-fade, a fresh effect run has already started
      // fading back up, and we must not tear down the audio element
      // out from under it.
      fadeVolume(audioEl.volume, 0, () => {
        if (audioEl && !useSettings.getState().musicEnabled) {
          audioEl.pause()
          // Drop the src so the underlying HTTP connection to the ICE
          // server is closed — otherwise the browser keeps pulling
          // bytes we'd just throw away.
          audioEl.removeAttribute('src')
          audioEl.load()
        }
      })
      return
    }
    const a = getAudio()
    const ch = findChannel(station)
    if (a.src !== ch.url) {
      // First play, or station swap. Start silent so the fade-in
      // ramps from zero. The previous station's audio (if any) is
      // killed by the src change — there's a small audible gap
      // before the new stream loads, which the fade-in then masks.
      a.src = ch.url
      cancelFade()
      a.volume = 0
    }
    a.play()
      .then(() => {
        // Guard against the user toggling off while play() was
        // pending: skip the fade-in so we don't fight a fade-out
        // already in flight on the next effect run.
        if (useSettings.getState().musicEnabled && audioEl) {
          fadeVolume(
            audioEl.volume,
            musicGain(useSettings.getState().musicVolume),
            () => {
              // Snap to the latest slider value after the fade-in
              // finishes: if the user adjusted volume during the
              // 600 ms ramp the fade headed for the old target, so
              // this re-syncs to current.
              if (audioEl && useSettings.getState().musicEnabled) {
                audioEl.volume = musicGain(
                  useSettings.getState().musicVolume,
                )
              }
            },
          )
        }
      })
      .catch(() => {
        useSettings.getState().setMusicEnabled(false)
      })
    // `volume` intentionally omitted — adjusting volume should not
    // re-seek or reload the stream. The dedicated volume effect below
    // mirrors slider changes during steady-state playback; mid-fade
    // changes are overwritten by the next rAF frame (acceptable: the
    // discontinuity is tiny) and the fade's onComplete re-syncs to
    // the latest slider value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, station])

  useEffect(() => {
    // Only mirror slider changes while we're not actively fading —
    // the rAF step is the volume's authority during a fade.
    if (audioEl && fadeRaf === null) audioEl.volume = musicGain(volume)
  }, [volume])
}
