// Synthesized sound effects. Built on the Web Audio API so we ship zero
// audio asset bytes — every preset is a tiny envelope-gated oscillator chain
// constructed on demand. Volume is sourced from the persisted settings store
// (0–100) and clamped against a MASTER_GAIN ceiling so even at 100% the
// playback can't exceed a comfortable level.
//
// Browser policy note: AudioContexts created before the first user gesture
// start in 'suspended' state and will silently no-op until resumed. Because
// the only path that calls playSfx() is a real user interaction (click,
// pointer, keyboard), the lazy resume() inside ctx() lands inside a gesture
// frame and the context activates. The very first call on a fresh page load
// — typically ModelLoader's "ready" chime — may still no-op if the model
// finished loading before the user clicked anything; that's intentional and
// preferable to forcing a context start without consent.
import { useSettings } from '../store/settings'

let _ctx: AudioContext | null = null

function ctx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (_ctx) {
    if (_ctx.state === 'suspended') void _ctx.resume()
    return _ctx
  }
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  if (!AC) return null
  try {
    _ctx = new AC()
    return _ctx
  } catch {
    return null
  }
}

interface Tone {
  // Single sustained frequency, or [start, end] for an exponential sweep.
  freq: number | [number, number]
  type?: OscillatorType
  // Duration of this tone in seconds.
  duration: number
  // Time offset from the play() call, in seconds. Lets one preset stack
  // multiple tones into a sequence/chord.
  delay?: number
  // Per-tone amplitude (0–1) multiplied against the master gain. Use this
  // to soften chord layers vs. the lead voice in the same preset.
  amp?: number
  // Attack time in seconds — the ramp from silence to peak. Defaults to
  // a near-instant 5 ms so taps and clicks read as snappy. Set longer
  // for pads / drones that should "swell in" rather than start at full
  // volume (used by the easter-egg wind anticipation). Capped at half
  // the tone's duration so the release always has time to run.
  attack?: number
}

const PRESETS: Record<string, Tone[]> = {
  // Generic short click — every-day button press.
  click: [{ freq: 1000, type: 'sine', duration: 0.04, amp: 0.5 }],
  // Tool-tab / view-switch — a touch lower so it's distinguishable from
  // an ordinary click.
  tab: [{ freq: 700, type: 'sine', duration: 0.07, amp: 0.6 }],
  // Generic open/close-style toggle for things that aren't directional
  // (soft-prereq toggle, sources <details>). Single tone so it doesn't
  // imply "opening" or "closing" — those have their own presets.
  toggle: [{ freq: 850, type: 'sine', duration: 0.06, amp: 0.6 }],
  // Pill-switch turning on — clean, brighter click. High transient over
  // a mid layer for body. Pitched higher than toggleOff so the on/off
  // semantics are audible without the user having to look at the switch.
  toggleOn: [
    { freq: 1200, type: 'sine', duration: 0.03, amp: 0.35 },
    { freq: 600, type: 'sine', duration: 0.05, amp: 0.4 },
  ],
  // Pill-switch turning off — mirror of toggleOn, shifted down a fifth
  // (roughly 1.5×). Same envelope shape so the pair feels like a matched
  // set; lower fundamentals so the off state reads as "settling down".
  toggleOff: [
    { freq: 800, type: 'sine', duration: 0.03, amp: 0.35 },
    { freq: 400, type: 'sine', duration: 0.05, amp: 0.4 },
  ],
  // Sidebar expand — rising sweep so it sounds like something opening up.
  // Higher pitch range than `send` and shorter so the two don't collide.
  expand: [{ freq: [520, 980], type: 'sine', duration: 0.1, amp: 0.55 }],
  // Sidebar collapse — descending mirror of `expand`. Same range, same
  // duration, opposite direction; the ear hears the inversion clearly.
  collapse: [{ freq: [980, 520], type: 'sine', duration: 0.1, amp: 0.55 }],
  // Course-lookup row expand. Softer and tighter than the sidebar `expand`
  // since this fires frequently as the user browses results — too much
  // chime gets tiring fast. Same up-vs-down inversion as the sidebar pair.
  courseExpand: [{ freq: [500, 720], type: 'sine', duration: 0.06, amp: 0.45 }],
  courseCollapse: [
    { freq: [720, 500], type: 'sine', duration: 0.06, amp: 0.45 },
  ],
  // PrereqTree disjunction (one-of dropdown) opening. Rising chirp that
  // suggests a menu dropping down. Pitches above the course-row pair so
  // the two are distinguishable when both can play in quick succession.
  dropdownOpen: [{ freq: [600, 900], type: 'sine', duration: 0.08, amp: 0.5 }],
  // Either/Or pick — a single rising sine sweep that reads as a swap:
  // pitch climbs quickly from mid to high, like a value being exchanged
  // upward into place. One voice, no chord, no body — minimal and modern.
  eitherPick: [{ freq: [700, 1400], type: 'sine', duration: 0.08, amp: 0.45 }],
  // Send message: upward sweep.
  send: [{ freq: [420, 940], type: 'sine', duration: 0.13, amp: 0.7 }],
  // Model ready / small win.
  success: [
    { freq: 660, type: 'sine', duration: 0.07, amp: 0.65 },
    { freq: 990, type: 'sine', duration: 0.11, amp: 0.65, delay: 0.07 },
  ],
  // Chat / model error: downward saw.
  error: [{ freq: [340, 160], type: 'square', duration: 0.24, amp: 0.45 }],
  // Conversation delete — a soft "tap-thunk": a brief high blip (the
  // dismissal click) followed by a low sine bump (the item landing in
  // the bin). The previous single descending triangle read as a
  // gunshot-style recoil; the two-stage sine pattern is recognisably
  // a "discard" gesture instead.
  delete: [
    { freq: 720, type: 'sine', duration: 0.035, amp: 0.4 },
    { freq: 220, type: 'sine', duration: 0.12, amp: 0.45, delay: 0.04 },
  ],
  // Very short blip for high-frequency feedback (volume slider).
  tick: [{ freq: 1500, type: 'sine', duration: 0.02, amp: 0.4 }],
  // Easter-egg phase 1 — "you found something". Quick rising sine sweep
  // fired the moment the ring-burst animation starts (rings fading in).
  // Short, bright, ear-grabbing — the user's first signal that an egg
  // was triggered, before the wind anticipation layer has built up.
  eggFound: [
    { freq: [400, 1400], type: 'sine', duration: 0.22, amp: 0.55 },
  ],
  // Easter-egg phase 2 — wind anticipation. Two slow rising sweeps
  // (triangle for body, sine for shimmer) with a long attack so the
  // volume swells through the rings-hold + rings-zoom phases rather
  // than firing at full amplitude immediately. Lasts ~1 second so it
  // naturally tails into the impact at t=1100 ms.
  eggWind: [
    {
      freq: [180, 480],
      type: 'triangle',
      duration: 0.95,
      amp: 0.4,
      attack: 0.4,
    },
    {
      freq: [270, 720],
      type: 'sine',
      duration: 0.95,
      amp: 0.25,
      attack: 0.4,
    },
  ],
  // Easter-egg phase 3 — victory chord on impact. Power chord (root +
  // fifth + octave) hits together, then two higher notes form an
  // ascending tail so the moment lands as triumphant rather than
  // tinkly. Replaces the old four-note arpeggio.
  eggVictory: [
    { freq: 660, type: 'sine', duration: 0.2, amp: 0.7 },
    { freq: 990, type: 'sine', duration: 0.2, amp: 0.55 },
    { freq: 1320, type: 'sine', duration: 0.24, amp: 0.55, delay: 0.04 },
    { freq: 1980, type: 'sine', duration: 0.18, amp: 0.5, delay: 0.16 },
    { freq: 2640, type: 'sine', duration: 0.3, amp: 0.5, delay: 0.28 },
  ],
  // Bot is "thinking" — a soft low pulse used as a periodic heartbeat
  // while we wait for the first streamed token. Quiet on purpose: the
  // user shouldn't be aware of it as a "beep", it should read as a
  // background metronome that signals the model is busy. Driven by
  // startBotThinking() / stopBotThinking() below.
  botThinking: [{ freq: 280, type: 'sine', duration: 0.1, amp: 0.25 }],
  // Bot is typing — one quiet high tick per streamed token, throttled
  // at the call site. Very low amplitude so a fast stream doesn't
  // turn into a buzzing wash; just a hint of "keys clacking".
  botTyping: [{ freq: 1200, type: 'sine', duration: 0.018, amp: 0.2 }],
  // Planner: picking up a course block. Quick upward chirp — short
  // and snappy so it reads as "grabbed" without cluttering a fast
  // drag sequence. Pitched between the course-expand and tab presets.
  dragLift: [{ freq: [440, 780], type: 'sine', duration: 0.07, amp: 0.45 }],
  // Planner: block placed into a term (move or new). Soft low thump
  // that sweeps down quickly — reads as something landing on a surface.
  // Used for both "add from lookup" and "reorder/move existing block".
  dragDrop: [
    { freq: [220, 100], type: 'sine', duration: 0.1, amp: 0.5 },
    { freq: [440, 200], type: 'sine', duration: 0.06, amp: 0.2 },
  ],
  // Planner: drag cancelled (dropped on nothing). Soft descending
  // blip — the block settling back to its origin. Lower energy than
  // dragLift so it feels like an undo, not a new action.
  dragCancel: [{ freq: [600, 340], type: 'sine', duration: 0.08, amp: 0.3 }],
  // Planner: trash drop — block deleted. Reuses the conversation-
  // delete shape (blip + low bump) but pitched slightly differently
  // so it feels related but contextually distinct.
  plannerTrash: [
    { freq: 680, type: 'sine', duration: 0.03, amp: 0.4 },
    { freq: 180, type: 'sine', duration: 0.14, amp: 0.4, delay: 0.035 },
  ],
  // Planner: autofill completed. Three quick ascending notes — a
  // mini-fanfare that signals "batch operation done" without the full
  // weight of the easter-egg victory chord.
  autofillDone: [
    { freq: 520, type: 'sine', duration: 0.06, amp: 0.5 },
    { freq: 660, type: 'sine', duration: 0.06, amp: 0.5, delay: 0.06 },
    { freq: 880, type: 'sine', duration: 0.1, amp: 0.55, delay: 0.12 },
  ],
  // Planner: "Clear All" pressed. Quick descending three-note motif
  // — the inverse of autofillDone — so it sounds like things being
  // swept away.
  plannerClear: [
    { freq: 880, type: 'sine', duration: 0.05, amp: 0.45 },
    { freq: 660, type: 'sine', duration: 0.05, amp: 0.45, delay: 0.05 },
    { freq: 440, type: 'sine', duration: 0.09, amp: 0.4, delay: 0.1 },
  ],
  // Planner: undo — short descending blip, the plan settling one step back.
  undo: [{ freq: [560, 360], type: 'triangle', duration: 0.09, amp: 0.4 }],
  // Planner: redo — ascending mirror of undo, one step forward again.
  redo: [{ freq: [360, 560], type: 'triangle', duration: 0.09, amp: 0.4 }],
}

// Hard ceiling on output gain. Each preset's per-tone `amp` multiplies
// against `(volume / 100) * MASTER_GAIN`, so at volume=100 a tone's peak
// gain is `MASTER_GAIN * amp`. The previous 0.18 made even max volume
// feel quiet (a typical click peaked at ~0.09, ~10% of full scale).
// 0.55 leaves the three-voice eggVictory chord at a worst-case
// constructive sum of ~0.99 — just under the 1.0 clipping point — so
// no preset distorts at full volume.
const MASTER_GAIN = 0.55

export type SfxName = keyof typeof PRESETS

// Per-preset last-play timestamps for the throttle path. Throttling is opt-
// in (caller passes minSpacingMs) so non-throttled calls retain frame-perfect
// responsiveness — only continuous-feedback callers like the volume slider
// need to bound the rate.
const lastPlayTimes = new Map<string, number>()

export function playSfx(name: SfxName, minSpacingMs?: number): void {
  // Gate against the persisted Audio toggles before doing anything else —
  // no AudioContext spin-up, no throttle bookkeeping, no oscillator setup.
  // `botThinking` / `botTyping` ride the separate "High-tech bot noises"
  // toggle; everything else is general SFX.
  const { sfxEnabled, botNoisesEnabled, volume: settingsVolume } =
    useSettings.getState()
  const isBotNoise = name === 'botThinking' || name === 'botTyping'
  if (isBotNoise ? !botNoisesEnabled : !sfxEnabled) return

  if (minSpacingMs && minSpacingMs > 0) {
    const last = lastPlayTimes.get(name) ?? 0
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (now - last < minSpacingMs) return
    lastPlayTimes.set(name, now)
  }

  const context = ctx()
  if (!context) return
  const volume = settingsVolume / 100
  const baseGain = volume * MASTER_GAIN
  if (baseGain <= 0) return
  const tones = PRESETS[name]
  if (!tones) return

  const t0 = context.currentTime
  for (const tone of tones) {
    const start = t0 + (tone.delay ?? 0)
    const end = start + tone.duration
    const osc = context.createOscillator()
    osc.type = tone.type ?? 'sine'
    if (Array.isArray(tone.freq)) {
      osc.frequency.setValueAtTime(tone.freq[0], start)
      // exponentialRampToValueAtTime requires a strictly positive target,
      // so clamp the sweep destination above zero.
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(0.0001, tone.freq[1]),
        end,
      )
    } else {
      osc.frequency.setValueAtTime(tone.freq, start)
    }
    const g = context.createGain()
    const peak = baseGain * (tone.amp ?? 1)
    // Attack + exponential release. Default 5 ms attack keeps clicks
    // snappy; longer attacks let pads/drones swell in (see `attack`
    // on Tone). Cap at half the duration so the release always runs.
    const attack = Math.min(tone.attack ?? 0.005, tone.duration * 0.5)
    g.gain.setValueAtTime(0.0001, start)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), start + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, end)
    osc.connect(g).connect(context.destination)
    osc.start(start)
    osc.stop(end + 0.02)
  }
}

// Periodic thinking pulse. Repeats `botThinking` on a fixed interval until
// stopBotThinking() is called. Idempotent — calling start while already
// running is a no-op, so Chat.tsx doesn't have to track whether it's
// already running before the user sends another message.
const THINKING_INTERVAL_MS = 500
let _thinkingTimer: ReturnType<typeof setInterval> | null = null

export function startBotThinking(): void {
  if (_thinkingTimer !== null) return
  // Fire the first pulse immediately so the user gets feedback that the
  // bot has started, then schedule the periodic continuation.
  playSfx('botThinking')
  _thinkingTimer = setInterval(
    () => playSfx('botThinking'),
    THINKING_INTERVAL_MS,
  )
}

export function stopBotThinking(): void {
  if (_thinkingTimer === null) return
  clearInterval(_thinkingTimer)
  _thinkingTimer = null
}
