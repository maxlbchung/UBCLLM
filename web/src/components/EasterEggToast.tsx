import { useEffect, useRef, useState } from 'react'
import { useEasterEggs } from '../store/easterEggs'
import { playSfx } from '../lib/sfx'

// SFX timeline lifted from the old sidebar counter:
//   t=0     eggFound + eggWind kick off (entrance + pad)
//   t=1100  eggVictory chord on the impact beat
//   t≈3600  spark / wind tail settles (eggWind ≈ 2.5 s decay after victory)
// The toast holds at full opacity until all of that is done, then sits
// for a brief PAUSE_MS so the user reads the message in silence, and
// finally fades out over FADE_MS. Total time on screen ≈
// SFX_COMPLETE_MS + PAUSE_MS + FADE_MS.
const SFX_COMPLETE_MS = 3600
const PAUSE_MS = 900
const VISIBLE_MS = SFX_COMPLETE_MS + PAUSE_MS
const FADE_MS = 600

// Animation timeline (mirrors the sidebar counter that lived here in
// pre-1.7.22 builds):
//   t=0     toast slides in; ring burst starts (egg-ring keyframe).
//   t=1100  IMPACT — count pops (egg-pop), sparks burst (egg-spark).
//   t=1200  rings unmounted (their animation hits scale 0 at 1150 ms).
//   t=3600  sparks unmounted (egg-spark runs 2500 ms post-impact).
const IMPACT_MS = 1100
const RING_LIFETIME_MS = 1200
const SPARK_LIFETIME_MS = IMPACT_MS + 2500

const PARTICLE_COUNT = 28

interface Particle {
  id: number
  dx: number
  dy: number
}

interface ActiveToast {
  id: number
  count: number
  showRings: boolean
  showSparks: boolean
  particles: Particle[]
  popKey: number
  fading: boolean
}

function makeParticles(seed: number): Particle[] {
  // Evenly spaced angular positions with a touch of jitter so consecutive
  // bursts don't look identical. Distance varies a little so the sparks
  // don't terminate on a perfect circle.
  return Array.from({ length: PARTICLE_COUNT }, (_, i) => {
    const baseAngle = (Math.PI * 2 * i) / PARTICLE_COUNT
    const angle = baseAngle + (Math.random() - 0.5) * 0.5
    const distance = 70 + Math.random() * 50
    return {
      id: seed + i,
      dx: Math.cos(angle) * distance,
      dy: Math.sin(angle) * distance,
    }
  })
}

/**
 * Floating discovery notice for easter eggs. Mounts at the App shell
 * level so it appears regardless of which view is active. Watches the
 * easter-eggs store for a fresh discovery and pops a brief, fading
 * toast at the bottom-center of the viewport. The persistent count
 * lives on the Other page; this component only fires on the moment
 * of discovery and carries the full celebration animation
 * (entrance rings + impact pop + spark burst) plus SFX timeline.
 */
export function EasterEggToast() {
  const discovered = useEasterEggs((s) => s.discovered)
  const validIds = useEasterEggs((s) => s.validIds)
  const loadFromCorpus = useEasterEggs((s) => s.loadFromCorpus)

  // Kick off the corpus load on mount so validIds is populated and the
  // discovery effect has something to compare against.
  useEffect(() => {
    void loadFromCorpus()
  }, [loadFromCorpus])

  const validIdSet = new Set(validIds)
  const discoveredCount = discovered.filter((id) => validIdSet.has(id)).length
  const eggTotal = validIds.length

  const [active, setActive] = useState<ActiveToast | null>(null)
  const prevCountRef = useRef(discoveredCount)
  const initializedRef = useRef(false)
  // Track every pending timer for the current burst so a back-to-back
  // discovery (or unmount) can cancel them cleanly — otherwise stale
  // setActive calls from a finished burst would reset state on the new
  // one and the animation would skip frames.
  const timersRef = useRef<number[]>([])

  useEffect(() => {
    // Wait for validIds to populate before establishing a baseline.
    // Until then discoveredCount is artificially 0; a fresh page load
    // would otherwise read every persisted egg as a "new" discovery.
    if (!initializedRef.current) {
      if (validIds.length > 0) {
        initializedRef.current = true
        prevCountRef.current = discoveredCount
      }
      return
    }
    if (discoveredCount <= prevCountRef.current) {
      prevCountRef.current = discoveredCount
      return
    }

    // Fresh discovery — clear any in-flight celebration and start over.
    timersRef.current.forEach(window.clearTimeout)
    timersRef.current = []

    const burstId = Date.now()
    setActive({
      id: burstId,
      count: discoveredCount,
      showRings: true,
      showSparks: false,
      particles: [],
      popKey: 0,
      fading: false,
    })

    playSfx('eggFound')
    playSfx('eggWind')

    const particles = makeParticles(burstId)

    const t1 = window.setTimeout(() => {
      setActive((a) =>
        a && a.id === burstId
          ? { ...a, showSparks: true, particles, popKey: a.popKey + 1 }
          : a,
      )
      playSfx('eggVictory')
    }, IMPACT_MS)
    const t2 = window.setTimeout(() => {
      setActive((a) =>
        a && a.id === burstId ? { ...a, showRings: false } : a,
      )
    }, RING_LIFETIME_MS)
    const t3 = window.setTimeout(() => {
      setActive((a) =>
        a && a.id === burstId ? { ...a, showSparks: false } : a,
      )
    }, SPARK_LIFETIME_MS)
    const t4 = window.setTimeout(() => {
      setActive((a) => (a && a.id === burstId ? { ...a, fading: true } : a))
    }, VISIBLE_MS)
    const t5 = window.setTimeout(() => {
      setActive((a) => (a && a.id === burstId ? null : a))
    }, VISIBLE_MS + FADE_MS)

    timersRef.current = [t1, t2, t3, t4, t5]

    prevCountRef.current = discoveredCount
    return () => {
      timersRef.current.forEach(window.clearTimeout)
      timersRef.current = []
    }
  }, [discoveredCount, validIds.length])

  if (!active) return null

  return (
    <div
      key={active.id}
      role="status"
      aria-live="polite"
      style={{
        // left:50% + translateX(-50%) horizontally centers the toast.
        // The egg-toast-in keyframe rides on top: it slides up + fades
        // in, with the same translateX(-50%) baked into the keyframe
        // so the resting transform matches the inline value.
        transform: 'translateX(-50%)',
        animation: 'egg-toast-in 400ms cubic-bezier(0.16, 1, 0.3, 1)',
        transition: `opacity ${FADE_MS}ms ease-out`,
        opacity: active.fading ? 0 : 1,
      }}
      className="pointer-events-none fixed bottom-10 left-1/2 z-50 rounded-lg border-2 border-highlight-fg bg-surface px-6 py-3 shadow-lg shadow-black/40"
    >
      <p className="text-center text-sm font-semibold tracking-wide text-highlight-fg">
        🎉 Easter Egg Found!
      </p>
      <p className="mt-1 text-center font-mono text-xs text-fg-muted">
        {/* Wrapper is relative + inline-block so the rings + sparks
            anchor to the count rather than the whole toast — same
            trick the old sidebar counter used. */}
        <span className="relative inline-block">
          <span
            key={active.popKey}
            className="inline-block origin-center"
            style={{
              animation:
                active.popKey > 0 ? 'egg-pop 450ms ease-out' : undefined,
            }}
          >
            <span className="text-highlight-fg">{active.count}</span> /{' '}
            {eggTotal || '–'}
          </span>
          {/* Anticipation rings — three same-size circles staggered by
              100ms / 150ms so they pulse out one after another instead
              of animating concentrically. Sized in rem so they scale
              with the rem-base. */}
          {active.showRings && (
            <span
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2"
            >
              {[0, 100, 150].map((delayMs, i) => (
                <span
                  key={i}
                  className="absolute left-0 top-0 rounded-full border-2 border-highlight-fg"
                  style={{
                    width: '4.2rem',
                    height: '4.2rem',
                    boxShadow:
                      '0 0 6px 1px color-mix(in oklab, var(--highlight-fg) 50%, transparent)',
                    animation: 'egg-ring 1150ms linear forwards',
                    animationDelay: `${delayMs}ms`,
                  }}
                />
              ))}
            </span>
          )}
          {active.showSparks && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0"
            >
              {active.particles.map((p) => (
                <span
                  key={p.id}
                  className="absolute left-1/2 top-1/2 h-2 w-2 rounded-full bg-highlight-fg"
                  style={
                    {
                      '--dx': `${p.dx}px`,
                      '--dy': `${p.dy}px`,
                      boxShadow:
                        '0 0 8px 2px color-mix(in oklab, var(--highlight-fg) 80%, transparent)',
                      animation:
                        'egg-spark 2500ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
                    } as React.CSSProperties
                  }
                />
              ))}
            </span>
          )}
        </span>{' '}
        discovered
      </p>
    </div>
  )
}
