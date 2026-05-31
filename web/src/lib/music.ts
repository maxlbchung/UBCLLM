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

// All live <audio> elements. Normally one; briefly two during a station
// crossfade (and momentarily more if the user spams the station picker
// faster than CROSSFADE_MS). Teardown walks this set so no retired stream
// is orphaned and left pulling bytes from the ICE server. `audioEl` is the
// current "primary" element — the one the volume slider and a fresh
// start/stop act on; during a crossfade the outgoing element stays in
// `liveEls` (but is no longer `audioEl`) until the ramp completes.
const liveEls = new Set<HTMLAudioElement>()
let audioEl: HTMLAudioElement | null = null

// Per-element error handlers, kept so we can detach them before teardown.
// Removing the src + load()-ing fires `error` on some browsers; during a
// crossfade that would otherwise flip musicEnabled off and kill the
// incoming stream too, so the handler MUST be gone before we dispose.
const errorHandlers = new WeakMap<HTMLAudioElement, () => void>()

// Build + register a fresh stream element. The `error` listener flips the
// music toggle off so the UI matches reality if the URL fails (bad mirror,
// network drop) — but only while the element is still live; dispose()
// detaches it first so an intentional teardown stays silent.
function attachAudio(): HTMLAudioElement {
  const el = new Audio()
  el.preload = 'none'
  const onError = () => {
    useSettings.getState().setMusicEnabled(false)
  }
  el.addEventListener('error', onError)
  errorHandlers.set(el, onError)
  liveEls.add(el)
  return el
}

function getAudio(): HTMLAudioElement {
  if (audioEl) return audioEl
  audioEl = attachAudio()
  return audioEl
}

// Stop an element and release its HTTP connection to the ICE server.
// Detaches the error handler first (see errorHandlers note) so the
// emptied-on-pause `error` doesn't bounce the toggle off.
function disposeAudio(el: HTMLAudioElement): void {
  const onError = errorHandlers.get(el)
  if (onError) {
    el.removeEventListener('error', onError)
    errorHandlers.delete(el)
  }
  el.pause()
  el.removeAttribute('src')
  el.load()
  liveEls.delete(el)
}

// Dispose every live element except the current primary. Called when a new
// ramp begins (and on disable) so we never accumulate orphaned streams from
// an interrupted crossfade — at most two elements are ever audible at once.
function disposeStragglers(): void {
  for (const el of liveEls) {
    if (el !== audioEl) disposeAudio(el)
  }
}

function findChannel(key: string): SomaChannel {
  return SOMAFM_CHANNELS.find((c) => c.key === key) ?? SOMAFM_CHANNELS[0]
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
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
// Station-swap crossfade window: the two streams overlap for its whole
// duration. 0.5 s reads as a quick blend — the old station ducks out as
// the new one comes up, just enough to mask the swap without a long
// DJ-style overlap. Only used by crossfade(), not the start/stop fade.
const CROSSFADE_MS = 500

// Single shared rAF handle: at most one ramp (a fade OR a crossfade) runs
// at a time. Starting either cancels whatever was in flight.
let fadeRaf: number | null = null

function cancelFade(): void {
  if (fadeRaf !== null) {
    cancelAnimationFrame(fadeRaf)
    fadeRaf = null
  }
}

// Ramp a single element's volume. Used for start (fade-in) and stop
// (fade-out); station swaps go through crossfade() instead. The element is
// passed explicitly (rather than reading the module `audioEl`) so the
// disable path can keep fading a captured element even after `audioEl` has
// been repointed. A frame whose element has been disposed mid-ramp is
// skipped via the liveEls check.
function fadeVolume(
  el: HTMLAudioElement,
  from: number,
  to: number,
  onComplete?: () => void,
): void {
  cancelFade()
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
    const t = Math.min(1, (now - startTime) / FADE_MS)
    const k = fadingOut ? 1 - (1 - t) ** 3 : t ** 3
    if (liveEls.has(el)) el.volume = clamp01(from + (to - from) * k)
    if (t >= 1) {
      fadeRaf = null
      onComplete?.()
      return
    }
    fadeRaf = requestAnimationFrame(step)
  }
  fadeRaf = requestAnimationFrame(step)
}

// Equal-power crossfade between two streams over CROSSFADE_MS, then fire
// onComplete (where the caller disposes the outgoing element). A linear —
// or the cubic fade above — ramp would dip in the middle: at t=0.5 both
// streams sit near their quiet end, so the combined loudness audibly sags.
// The cos/sin pair keeps summed acoustic power (gain²) ~constant across the
// swap so loudness holds steady:
//   outgoing gain = fromOld · cos(t · π/2)   (full → silent)
//   incoming gain = toNew  · sin(t · π/2)    (silent → full)
function crossfade(
  oldEl: HTMLAudioElement,
  newEl: HTMLAudioElement,
  fromOld: number,
  toNew: number,
  onComplete?: () => void,
): void {
  cancelFade()
  const startTime = performance.now()
  const step = (now: number): void => {
    const t = Math.min(1, (now - startTime) / CROSSFADE_MS)
    const k = (t * Math.PI) / 2
    if (liveEls.has(oldEl)) oldEl.volume = clamp01(fromOld * Math.cos(k))
    if (liveEls.has(newEl)) newEl.volume = clamp01(toNew * Math.sin(k))
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
      if (!audioEl) {
        // Nothing primary, but an outgoing crossfade element could still
        // be live if the toggle flipped off at just the wrong moment.
        disposeStragglers()
        return
      }
      const primary = audioEl
      // Drop any outgoing crossfade element immediately — no point ramping
      // two streams down to silence at once.
      disposeStragglers()
      // Fade the primary out, then release it. The toggle is re-checked
      // inside onComplete: if the user re-enabled mid-fade, a fresh effect
      // run has already started fading this same element back up, and we
      // must not tear it out from under that.
      fadeVolume(primary, primary.volume, 0, () => {
        if (audioEl === primary && !useSettings.getState().musicEnabled) {
          disposeAudio(primary)
          audioEl = null
        }
      })
      return
    }

    const ch = findChannel(station)

    // Station swap while a stream is actively playing → crossfade the
    // outgoing stream against a freshly-built incoming one. This is the
    // only path that overlaps two elements; everything else reuses the
    // single primary element. (`!paused` rules out a torn-down primary; a
    // matching src means we're already on this station and skip the swap.)
    if (audioEl && !audioEl.paused && audioEl.src && audioEl.src !== ch.url) {
      // Collapse any older in-flight swap first so we never stack more than
      // two streams: the current primary becomes the outgoing element and
      // any earlier straggler is dropped (it was already near silence).
      disposeStragglers()
      const oldEl = audioEl
      const nextEl = attachAudio()
      nextEl.src = ch.url
      nextEl.volume = 0
      // Promote immediately so the volume-slider effect and any re-entrant
      // effect run target the incoming stream, not the one being retired.
      audioEl = nextEl
      nextEl
        .play()
        .then(() => {
          // A newer swap or a toggle-off may have superseded this start
          // while play() was pending. If we're no longer primary, bail and
          // let whoever superseded us own teardown.
          if (audioEl !== nextEl || !useSettings.getState().musicEnabled) {
            return
          }
          crossfade(
            oldEl,
            nextEl,
            oldEl.volume,
            musicGain(useSettings.getState().musicVolume),
            () => {
              disposeAudio(oldEl)
              // Snap to the latest slider value if it moved during the swap.
              if (audioEl === nextEl && useSettings.getState().musicEnabled) {
                nextEl.volume = musicGain(useSettings.getState().musicVolume)
              }
            },
          )
        })
        .catch(() => {
          // Incoming stream failed to start (bad mirror, network). Drop it
          // and keep the old stream — it never stopped — as primary. Don't
          // flip musicEnabled off: playback is still healthy.
          disposeAudio(nextEl)
          if (audioEl === nextEl) audioEl = oldEl
        })
      return
    }

    // Fresh start, or a fade-in / re-enable of the same station. Reuse the
    // single primary element.
    const a = getAudio()
    if (a.src !== ch.url) {
      // First play, or a swap from a torn-down (paused, src-less) state.
      // Start silent so the fade-in ramps from zero.
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
            audioEl,
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
    // `volume` is intentionally NOT a dep — adjusting volume should not
    // re-seek or reload the stream. The effect only reads the live volume
    // via getState() (never the reactive closure), so exhaustive-deps is
    // already satisfied by [enabled, station]. The dedicated volume effect
    // below mirrors slider changes during steady-state playback; mid-ramp
    // changes are overwritten by the next rAF frame (acceptable: the
    // discontinuity is tiny) and the ramp's onComplete re-syncs to the
    // latest slider value.
  }, [enabled, station])

  useEffect(() => {
    // Only mirror slider changes while no ramp (fade or crossfade) is
    // running — the rAF step is the volume's authority during one.
    if (audioEl && fadeRaf === null) audioEl.volume = musicGain(volume)
  }, [volume])
}
