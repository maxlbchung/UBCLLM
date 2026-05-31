import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type WheelEvent,
} from 'react'
import { useConversations } from '../store/conversations'
import { ROUTES, navigate } from '../lib/router'
import { playSfx } from '../lib/sfx'
import {
  FALLBACK_HOME_BACKGROUND_SCENE,
  loadHomeBackgroundScene,
  type HomeBackgroundBox,
} from '../lib/homeBackground'
import {
  CalendarIcon,
  ChatIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GradCapIcon,
  GraphIcon,
  SearchIcon,
  type IconProps,
} from './icons'

// Landing page. Qwen loading is intentionally deferred until the /app shell
// opens, so this page can keep the home background isolated from WebGPU model
// setup work. The page is a calm full-screen welcome, then a spinning pseudo-3D
// "tool wheel" in the next section that selects each destination (Ask AI + the
// companion tools + the campus calendar).
//
// Layout intent: the hero is its own full-viewport fold (min-h-screen), so the
// tool wheel lives in the *next* section and starts just past the fold — out
// of view on load, reached by the hero's "Get started" cue (or by scrolling).
// The campus calendar is also reachable as its own tab in the app shell (see
// CalendarPage); the wheel's Calendar item routes there.

// One entry per wheel slot. `key` doubles as the routing discriminant in
// Home.selectWheelItem ('chat' / 'calendar' are special-cased; the rest map
// 1:1 onto the app shell's tool tabs).
type WheelItem = {
  key: 'chat' | 'lookup' | 'prereq' | 'planning' | 'calendar'
  Icon: ComponentType<IconProps>
  title: string
  desc: string
  badge?: string
}

const WHEEL_ITEMS: WheelItem[] = [
  {
    key: 'chat',
    Icon: ChatIcon,
    title: 'Ask AI',
    badge: 'Beta',
    desc: 'Chat about UBC courses, programs, and faculties.',
  },
  {
    key: 'lookup',
    Icon: SearchIcon,
    title: 'Course Finder',
    desc: 'Search and filter the full UBC course catalogue by code, subject, or level.',
  },
  {
    key: 'prereq',
    Icon: GraphIcon,
    title: 'Prerequisite Visualizer',
    desc: 'See a full prerequisite graph to build a path to your desired courses.',
  },
  {
    key: 'planning',
    Icon: GradCapIcon,
    title: 'Degree Planner',
    desc: 'Build a multi-year schedule and check it against your program requirements.',
  },
  {
    key: 'calendar',
    Icon: CalendarIcon,
    title: 'Campus Calendar',
    desc: 'Browse UBC term dates, deadlines, and statutory holidays.',
  },
]

// Wheel geometry. Cards orbit a circle whose front slot (nearest, lowest) is
// the focused one; depth (cos of the slot angle) drives scale + opacity + blur
// + z, so receding cards shrink and fade — a pseudo-3D turntable whose face
// tips toward the viewer. radiusX is measured from the stage at runtime;
// radiusY is a fraction of it so the arc stays shallow (the "face down" tilt).
const MIN_SCALE = 0.55 // scale of the farthest visible card
const BLUR_MAX = 4 // px blur on the farthest visible card
const BANK = 0 // banking rotation applied per degree of orbit (0 = upright)

const WHEEL_ARROW_CLASS =
  'z-20 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-line bg-surface-soft text-fg-muted transition-colors duration-200 hover:border-accent/50 hover:bg-surface-raised hover:text-accent active:scale-95'

const WHEEL_CARD_CLASS =
  'home-wheel-card absolute left-1/2 top-1/2 flex h-48 w-64 flex-col items-start gap-3 rounded-2xl border border-line bg-surface-soft p-6 text-left'

const WHEEL_CARD_FRONT_CLASS =
  'group cursor-pointer hover:border-accent/50 hover:bg-surface-raised hover:shadow-2xl hover:shadow-black/20'

const ICON_TILE_CLASS =
  'flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-accent transition-colors duration-200 group-hover:bg-accent group-hover:text-accent-fg'

const SCROLL_CUE_CLASS =
  'group flex flex-col items-center gap-1.5 text-fg-faint transition-colors hover:text-accent'

const DEAD_SCROLLSPACE_CLASS = 'min-h-[60vh]'
const CUBE_RENDER_MARGIN_TILES = 2
const INITIAL_CUBE_TILE_RANGE = { min: -14, max: 10 }
const HALF_CYLINDER_SHELL_MAX_HEIGHT_PX = 248
const HALF_CYLINDER_SHELL_MAX_ARC_ANGLE_DEG = 90

const SOCIAL_LINKS = [
  { label: 'GitHub', href: 'https://github.com/maxlbchung' },
  { label: 'Discussions', href: 'https://github.com/maxlbchung/UBCLLM/discussions' },
  { label: 'YouTube', href: 'https://www.youtube.com/@libodev' },
  { label: 'Instagram', href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=ygUIcmlja3JvbGw%3D' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/max-li-bo-chung/' },
  { label: 'Email', href: 'mailto:reodite@libo.dev' },
]

function getPyramidFaceVars(
  widthPx: number,
  depthPx: number,
  heightPx: number,
) {
  const halfWidth = Math.max(1, widthPx / 2)
  const halfDepth = Math.max(1, depthPx / 2)
  const frontSlant = Math.hypot(heightPx, halfDepth)
  const sideSlant = Math.hypot(heightPx, halfWidth)
  const frontAngle = -(Math.atan2(heightPx, halfDepth) * 180) / Math.PI
  const sideAngle = (Math.atan2(heightPx, halfWidth) * 180) / Math.PI

  return {
    '--pyramid-front-angle': `${frontAngle.toFixed(4)}deg`,
    '--pyramid-front-slant': `${frontSlant.toFixed(3)}px`,
    '--pyramid-side-left-angle': `${(-sideAngle).toFixed(4)}deg`,
    '--pyramid-side-right-angle': `${sideAngle.toFixed(4)}deg`,
    '--pyramid-side-slant': `${sideSlant.toFixed(3)}px`,
  } as CSSProperties
}

function getHalfCylinderShellVars(
  baseArcAngleDeg: number,
  heightPx: number,
) {
  const t = Math.max(
    0,
    Math.min(1, heightPx / HALF_CYLINDER_SHELL_MAX_HEIGHT_PX),
  )
  const easedT = t * t * (3 - 2 * t)
  const arcAngleDeg =
    baseArcAngleDeg +
    (HALF_CYLINDER_SHELL_MAX_ARC_ANGLE_DEG - baseArcAngleDeg) * easedT
  const angleRad = (arcAngleDeg * Math.PI) / 180
  // The shell pivots from the interior diameter edge, but its free edge
  // should meet the cap at arcAngleDeg up from the exterior diameter edge.
  const shellWidth = Math.hypot(1 + Math.cos(angleRad), Math.sin(angleRad))
  const shellRotationDeg = 180 - arcAngleDeg / 2
  const shellLineWidthRatio = 1 / Math.max(0.001, Math.cos(angleRad / 2))

  return {
    '--half-cylinder-shell-left-rotation': `${-shellRotationDeg.toFixed(4)}deg`,
    '--half-cylinder-shell-right-rotation': `${shellRotationDeg.toFixed(4)}deg`,
    '--half-cylinder-shell-line-width-ratio':
      shellLineWidthRatio.toFixed(8),
    '--half-cylinder-shell-width-ratio': shellWidth.toFixed(8),
  } as CSSProperties
}

function GridBox({
  box,
  halfCylinderShellArcAngleDeg,
  tileSize,
}: {
  box: HomeBackgroundBox
  halfCylinderShellArcAngleDeg: number
  tileSize: number
}) {
  const kind = box.kind === 'box' ? 'cube' : box.kind ?? 'cube'
  const widthTiles = box.widthTiles ?? 1
  const depthTiles = box.depthTiles ?? 1
  const widthPx = widthTiles * tileSize
  const depthPx = depthTiles * tileSize
  const halfCylinderHeightPx = widthPx / 2
  const heightPx =
    kind === 'halfCylinder' ? halfCylinderHeightPx : box.heightPx ?? tileSize
  const hat = kind === 'cube' ? box.hat : undefined
  const hatHeightPx =
    hat?.kind === 'halfCylinder'
      ? halfCylinderHeightPx
      : hat?.heightPx ?? 0
  const opacity = box.opacity ?? 1
  const sideFaceClass =
    box.xTiles <= 0
      ? 'home-grid-box__face--right'
      : 'home-grid-box__face--left'
  const pyramidSide = box.xTiles <= 0 ? 'right' : 'left'
  const halfCylinderSideClass =
    box.xTiles <= 0
      ? 'home-grid-box__half-cylinder--left'
      : 'home-grid-box__half-cylinder--right'
  const renderFaces = (
    renderKind: 'cube' | 'pyramid' | 'tent' | 'halfCylinder',
    includeHalfShell = true,
  ) => {
    if (renderKind === 'pyramid') {
      return (
        <>
          <span className="home-grid-box__pyramid-anchor home-grid-box__pyramid-anchor--front">
            <span className="home-grid-box__pyramid-face home-grid-box__pyramid-face--front" />
          </span>
          <span
            className={`home-grid-box__pyramid-anchor home-grid-box__pyramid-anchor--${pyramidSide}`}
          >
            <span
              className={`home-grid-box__pyramid-face home-grid-box__pyramid-face--${pyramidSide}`}
            />
          </span>
        </>
      )
    }
    if (renderKind === 'tent') {
      return (
        <>
          <span className="home-grid-box__triangle home-grid-box__triangle--front" />
          <span
            className={`home-grid-box__tent-plane-anchor home-grid-box__tent-plane-anchor--${pyramidSide}`}
          >
            <span
              className={`home-grid-box__tent-plane home-grid-box__tent-plane--${pyramidSide}`}
            />
          </span>
        </>
      )
    }
    if (renderKind === 'halfCylinder') {
      return (
        <>
          <span
            className={`home-grid-box__half-cap home-grid-box__half-cap--front ${halfCylinderSideClass}`}
          />
          <span
            className={`home-grid-box__half-cap home-grid-box__half-cap--back ${halfCylinderSideClass}`}
          />
          {includeHalfShell && (
            <span
              className={`home-grid-box__half-shell-anchor ${halfCylinderSideClass}`}
            >
              <span
                className={`home-grid-box__half-shell ${halfCylinderSideClass}`}
              />
            </span>
          )}
        </>
      )
    }
    return (
      <>
        <span className="home-grid-box__face home-grid-box__face--top" />
        <span className="home-grid-box__face home-grid-box__face--front" />
        <span className={`home-grid-box__face ${sideFaceClass}`} />
      </>
    )
  }

  const boxStyle = {
    '--box-x': `${box.xTiles * tileSize}px`,
    '--box-y': `${box.yTiles * tileSize}px`,
    '--box-w': `${widthPx}px`,
    '--box-d': `${depthPx}px`,
    '--box-h': `${heightPx}px`,
    '--base-h': `${heightPx}px`,
    '--hat-h': `${hatHeightPx}px`,
    '--ground-opacity': opacity,
    ...getPyramidFaceVars(widthPx, depthPx, heightPx),
    ...(kind === 'halfCylinder'
      ? getHalfCylinderShellVars(halfCylinderShellArcAngleDeg, 0)
      : {}),
  } as CSSProperties
  const boxNode = (
    <div
      className={`home-grid-box home-grid-box--${kind}${hat ? ' home-grid-box--with-hat' : ''}`}
      data-ground-fade-y={box.yTiles * tileSize}
      style={boxStyle}
    >
      {renderFaces(kind)}
      {hat && (
        <div
          className={`home-grid-box__hat home-grid-box__hat--${hat.kind}`}
          style={{
            ...getPyramidFaceVars(widthPx, depthPx, hatHeightPx),
            ...(hat.kind === 'halfCylinder'
              ? getHalfCylinderShellVars(
                  halfCylinderShellArcAngleDeg,
                  heightPx,
                )
              : {}),
          }}
        >
          {renderFaces(hat.kind)}
        </div>
      )}
    </div>
  )

  return boxNode
}

function SocialIcon({ label }: { label: string }) {
  const common = {
    className: 'h-3.5 w-3.5 shrink-0',
    'aria-hidden': true,
  }

  switch (label) {
    case 'GitHub':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.69c-2.78.61-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.35 1.08 2.92.83.09-.65.35-1.08.63-1.33-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.01c.85 0 1.7.11 2.5.34 1.9-1.29 2.74-1.02 2.74-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.86v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
        </svg>
      )
    case 'YouTube':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path d="M21.5 7.2a3 3 0 0 0-2.1-2.1C17.55 4.6 12 4.6 12 4.6s-5.55 0-7.4.5a3 3 0 0 0-2.1 2.1A31 31 0 0 0 2 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.85.5 7.4.5 7.4.5s5.55 0 7.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 22 12a31 31 0 0 0-.5-4.8Z" stroke="currentColor" strokeWidth="1.8" />
          <path d="m10 15.2 5.2-3.2L10 8.8v6.4Z" fill="currentColor" />
        </svg>
      )
    case 'Discussions':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path d="M5 6.5h14v9.2H9.7L5 19.5v-13Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M8.8 10h6.4M8.8 12.8h4.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'Instagram':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <rect x="4" y="4" width="16" height="16" rx="4.5" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="3.4" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="16.9" cy="7.1" r="1" fill="currentColor" />
        </svg>
      )
    case 'LinkedIn':
      return (
        <svg {...common} viewBox="0 0 24 24" fill="currentColor">
          <path d="M6.7 8.9H3.4v10.7h3.3V8.9ZM5.05 4a1.93 1.93 0 1 0 0 3.86A1.93 1.93 0 0 0 5.05 4Zm14.55 9.65c0-3.22-1.72-4.72-4.02-4.72-1.85 0-2.68 1.02-3.14 1.74V8.9H9.26v10.7h3.31v-5.29c0-1.39.26-2.73 1.99-2.73 1.7 0 1.72 1.59 1.72 2.82v5.2h3.32v-5.95Z" />
        </svg>
      )
    default:
      return (
        <svg {...common} viewBox="0 0 24 24" fill="none">
          <path d="M4.5 6.5h15v11h-15v-11Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="m5 7 7 6 7-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
  }
}

// Duration of the "Get started" scroll-to-tools glide. Native smooth scroll is
// ~0.4–0.6s for one viewport; this is deliberately slower so the floor visibly
// streams forward during the drop. Bump it to slow the descent further.
const SCROLL_TO_TOOLS_MS = 1400

// The tool wheel: a pseudo-3D carousel of WHEEL_ITEMS. The focused card sits
// at the front (nearest/lowest, the only clickable one); the rest orbit up and
// back, shrinking + fading by depth. Left/right arrows (and ← →, and the dots)
// rotate which item is up front. radiusX tracks the stage width so the side
// cards stay on-screen as it narrows.
function ToolWheel({ onSelect }: { onSelect: (item: WheelItem) => void }) {
  const N = WHEEL_ITEMS.length
  const [active, setActive] = useState(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const [radiusX, setRadiusX] = useState(320)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () =>
      setRadiusX(Math.max(140, Math.min(stage.clientWidth * 0.3, 340)))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [])

  const radiusY = radiusX * 0.22
  const stepAngle = (2 * Math.PI) / N

  const spin = (dir: number) => {
    playSfx('tab')
    setActive((a) => (a + dir + N) % N)
  }

  // Shortest signed offset of item i from the front, in [-N/2, N/2]. Cards
  // beyond the visible front arc wrap around the back at opacity 0, so the
  // seam where +offset meets -offset is never seen.
  const offsetOf = (i: number) => {
    let o = ((i - active) % N + N) % N
    if (o > N / 2) o -= N
    return o
  }

  return (
    <div
      role="group"
      aria-label="Choose a tool"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          spin(-1)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          spin(1)
        }
      }}
      className="home-rise flex w-full max-w-5xl flex-col items-center gap-7 outline-none"
      style={{ animationDelay: '120ms' }}
    >
      <div ref={stageRef} className="relative -mt-10 h-[20rem] w-full">
        {WHEEL_ITEMS.map((item, i) => {
          const o = offsetOf(i)
          const phi = o * stepAngle
          const cos = Math.cos(phi)
          const sin = Math.sin(phi)
          const depth = (cos + 1) / 2 // 0 at back, 1 at front
          const isFront = o === 0
          const hidden = cos < -0.3 // tuck the back arc away entirely
          const scale = MIN_SCALE + depth * (1 - MIN_SCALE)
          const x = sin * radiusX
          const y = cos * radiusY // front (cos 1) sits lowest
          const blur = (1 - depth) * BLUR_MAX
          const rot = ((phi * 180) / Math.PI) * BANK
          return (
            <button
              key={item.key}
              type="button"
              tabIndex={isFront ? 0 : -1}
              aria-hidden={!isFront}
              onClick={() => (isFront ? onSelect(item) : spin(o))}
              className={`${WHEEL_CARD_CLASS}${
                isFront ? ` ${WHEEL_CARD_FRONT_CLASS}` : ' cursor-pointer'
              }`}
              style={{
                transform: `translate(-50%, -50%) translate(${x.toFixed(
                  1,
                )}px, ${y.toFixed(1)}px) scale(${scale.toFixed(
                  3,
                )}) rotate(${rot.toFixed(2)}deg)`,
                opacity: hidden
                  ? 0
                  : isFront
                    ? 1
                    : Number(Math.pow(depth, 1.4).toFixed(3)),
                filter: blur > 0.15 ? `blur(${blur.toFixed(1)}px)` : undefined,
                zIndex: Math.round(depth * 100),
                pointerEvents: hidden ? 'none' : 'auto',
              }}
            >
              <div className="flex w-full items-center gap-5">
                <span className={ICON_TILE_CLASS}>
                  <item.Icon className="h-6 w-6" />
                </span>
                <span className="flex items-center gap-2 text-base font-semibold">
                  {item.title}
                  {item.badge && (
                    <span className="rounded-full border border-highlight/40 px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-wider text-highlight">
                      {item.badge}
                    </span>
                  )}
                </span>
              </div>
              <div className="flex flex-1 items-center">
                <span className="line-clamp-3 text-sm leading-relaxed text-fg-muted">
                  {item.desc}
                </span>
              </div>
            </button>
          )
        })}
      </div>

      {/* Position dots — click to jump straight to a tool. */}
      <div className="flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={() => spin(-1)}
          aria-label="Previous tool"
          className={WHEEL_ARROW_CLASS}
        >
          <ChevronLeftIcon className="h-6 w-6" />
        </button>

        <div className="flex min-w-32 items-center justify-center gap-2.5">
          {WHEEL_ITEMS.map((item, i) => (
            <button
              key={item.key}
              type="button"
              aria-label={`Show ${item.title}`}
              onClick={() => {
                playSfx('tab')
                setActive(i)
              }}
              className={`h-2 rounded-full transition-all duration-300 ${
                i === active
                  ? 'w-6 bg-accent'
                  : 'w-2 bg-line-soft hover:bg-fg-faint'
              }`}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={() => spin(1)}
          aria-label="Next tool"
          className={WHEEL_ARROW_CLASS}
        >
          <ChevronRightIcon className="h-6 w-6" />
        </button>
      </div>
    </div>
  )
}

export function Home() {
  const newConversation = useConversations((s) => s.newConversation)
  const setView = useConversations((s) => s.setView)
  const order = useConversations((s) => s.order)
  const setActive = useConversations((s) => s.setActive)
  const [backgroundScene, setBackgroundScene] = useState(
    FALLBACK_HOME_BACKGROUND_SCENE,
  )
  const [visibleTileRange, setVisibleTileRange] = useState(
    INITIAL_CUBE_TILE_RANGE,
  )
  const {
    boxes,
    groundScrollFactor,
    halfCylinderShellArcAngleDeg,
    horizonGapPx,
    tileSize,
  } = backgroundScene
  const visibleBoxes = useMemo(
    () =>
      boxes.filter((box) => {
        const depthTiles = box.depthTiles ?? 1
        const boxMinY = box.yTiles
        const boxMaxY = box.yTiles + depthTiles
        return boxMaxY >= visibleTileRange.min && boxMinY <= visibleTileRange.max
      }),
    [boxes, visibleTileRange],
  )

  const blocksRef = useRef<HTMLElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const heroRef = useRef<HTMLElement>(null)
  const heroUiRef = useRef<HTMLDivElement>(null)
  const toolsUiRef = useRef<HTMLDivElement>(null)
  const aboutRef = useRef<HTMLElement>(null)
  const aboutUiRef = useRef<HTMLDivElement>(null)
  const jumpNavRef = useRef<HTMLDivElement>(null)
  const landscapeRef = useRef<HTMLDivElement>(null)
  const streamerRef = useRef<HTMLDivElement>(null)
  const descRef = useRef<HTMLParagraphElement>(null)
  const ctaRef = useRef<HTMLButtonElement>(null)
  const scrollAnimRef = useRef<number | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    loadHomeBackgroundScene(controller.signal)
      .then(setBackgroundScene)
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.warn(error)
        }
      })
    return () => controller.abort()
  }, [])

  // Pin the synthwave horizon just below the primary CTA rather than letting
  // decorative scene content influence layout. The whole hero stack is vertically centered, so the
  // gap's screen position depends on the copy's height — measure it instead of
  // hardcoding a percentage. offsetTop/offsetHeight are immune to the entrance
  // animation's translateY (unlike getBoundingClientRect), so we read true
  // resting positions even mid-cascade. Re-measure on any hero reflow/resize.
  useLayoutEffect(() => {
    const hero = heroRef.current
    const scroller = scrollerRef.current
    const landscape = landscapeRef.current
    const desc = descRef.current
    const cta = ctaRef.current
    if (!hero || !scroller || !landscape || !desc || !cta) return

    // Sum offsetTop up the offsetParent chain until we reach the hero section,
    // giving a position relative to the hero regardless of intervening
    // unpositioned wrappers.
    const topWithin = (el: HTMLElement, ancestor: HTMLElement) => {
      let y = 0
      let node: HTMLElement | null = el
      while (node && node !== ancestor) {
        y += node.offsetTop
        node = node.offsetParent as HTMLElement | null
      }
      return y
    }

    const measure = () => {
      const ctaBottom = topWithin(cta, hero) + cta.offsetHeight
      const horizonY = ctaBottom + horizonGapPx
      landscape.style.setProperty('--horizon-y', `${horizonY}px`)
      scroller.style.setProperty(
        '--home-ui-bottom',
        `${Math.max(240, Math.min(window.innerHeight, horizonY))}px`,
      )
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(hero)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [horizonGapPx])

  // Drive the floor forward as the page scrolls: scrolling down streams the
  // grid toward the viewer (the floor has no idle motion of its own). The grid
  // gets a one-tile modulo offset so its repeated texture wraps cleanly, while
  // the visible ground props get the continuous offset so they do not snap back
  // when the texture repeats.
  useEffect(() => {
    const scroller = scrollerRef.current
    const streamer = streamerRef.current
    const hero = heroRef.current
    const blocks = blocksRef.current
    const about = aboutRef.current
    const heroUi = heroUiRef.current
    const toolsUi = toolsUiRef.current
    const aboutUi = aboutUiRef.current
    const jumpNav = jumpNavRef.current
    if (!scroller || !streamer || !hero || !blocks || !about || !heroUi || !toolsUi || !aboutUi || !jumpNav) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let ticking = false
    let disposed = false
    const clamp01 = (n: number) => Math.max(0, Math.min(1, n))
    const smoothstep = (edge0: number, edge1: number, x: number) => {
      const t = clamp01((x - edge0) / (edge1 - edge0))
      return t * t * (3 - 2 * t)
    }
    const setUi = (
      el: HTMLElement,
      opacity: number,
      scale: number,
      pointerEvents: 'auto' | 'none',
    ) => {
      el.style.setProperty('--home-ui-opacity', opacity.toFixed(3))
      el.style.setProperty('--home-ui-scale', scale.toFixed(3))
      el.style.setProperty('--home-ui-pointer-events', pointerEvents)
      el.style.setProperty(
        '--home-ui-visibility',
        opacity > 0.01 ? 'visible' : 'hidden',
      )
    }

    const alignGroundGrid = () => {
      const anchor = streamer.offsetWidth * 0.5
      streamer.style.setProperty('--ground-grid-origin-x', `${anchor}px`)
    }
    const getFadeBounds = () => {
      const streamerH = Math.max(1, streamer.clientHeight)
      const horizonFadeStart = -tileSize
      const horizonFadeEnd = tileSize * 1.5
      const bottomFadeStart = Math.max(
        horizonFadeEnd + tileSize * 4,
        streamerH - tileSize * 6,
      )
      const bottomFadeEnd = bottomFadeStart + tileSize * 3
      return {
        bottomFadeEnd,
        bottomFadeStart,
        horizonFadeEnd,
        horizonFadeStart,
        streamerH,
      }
    }

    const updateVisibleBoxRange = (groundOffset: number) => {
      const { bottomFadeEnd, horizonFadeStart } = getFadeBounds()
      const marginPx = tileSize * CUBE_RENDER_MARGIN_TILES
      const min = Math.floor(
        (-groundOffset + horizonFadeStart - marginPx) / tileSize,
      )
      const max = Math.ceil((-groundOffset + bottomFadeEnd + marginPx) / tileSize)
      setVisibleTileRange((prev) =>
        prev.min === min && prev.max === max ? prev : { min, max },
      )
    }

    const updateGroundFades = (groundOffset: number) => {
      const {
        bottomFadeEnd,
        bottomFadeStart,
        horizonFadeEnd,
        horizonFadeStart,
        streamerH,
      } = getFadeBounds()
      const groundFaders = streamer.querySelectorAll<HTMLElement>(
        '[data-ground-fade-y]',
      )

      for (const el of groundFaders) {
        const rawY = Number(el.dataset.groundFadeY ?? 0)
        const baseY =
          el.dataset.groundFadeUnit === 'ratio' ? rawY * streamerH : rawY
        const y = baseY + groundOffset
        const fadeIn = smoothstep(horizonFadeStart, horizonFadeEnd, y)
        const fadeOut = 1 - smoothstep(bottomFadeStart, bottomFadeEnd, y)
        el.style.setProperty('--ground-fade', (fadeIn * fadeOut).toFixed(3))
      }
    }

    const update = () => {
      if (disposed) return
      ticking = false
      const actualScroll = scroller.scrollTop
      const groundOffset = actualScroll * groundScrollFactor
      const gridShift = (groundOffset % tileSize).toFixed(2)
      const groundShift = groundOffset.toFixed(2)
      const viewportH = Math.max(1, scroller.clientHeight)
      const jumpIn = smoothstep(0.18, 0.32, actualScroll / viewportH)
      const sectionProgress = (section: HTMLElement) =>
        (section.offsetTop - actualScroll) / viewportH
      const groupOpacity = (section: HTMLElement) => {
        const distance = Math.abs(sectionProgress(section))
        return 1 - smoothstep(0.28, 0.58, distance)
      }
      const groupScale = (section: HTMLElement, opacity: number) => {
        const progress = sectionProgress(section)
        return progress < 0
          ? 1 + (1 - opacity) * 0.18
          : 0.78 + opacity * 0.22
      }
      const heroOpacity = groupOpacity(hero)
      const toolsOpacity = groupOpacity(blocks)
      const aboutOpacity = groupOpacity(about)
      const activeGroup =
        aboutOpacity >= heroOpacity && aboutOpacity >= toolsOpacity
          ? 'about'
          : toolsOpacity >= heroOpacity
            ? 'tools'
            : 'hero'
      streamer.style.setProperty('--scroll-shift', `${gridShift}px`)
      streamer.style.setProperty('--ground-shift', `${groundShift}px`)
      updateVisibleBoxRange(groundOffset)
      updateGroundFades(groundOffset)
      setUi(heroUi, heroOpacity, groupScale(hero, heroOpacity), activeGroup === 'hero' ? 'auto' : 'none')
      setUi(toolsUi, toolsOpacity, groupScale(blocks, toolsOpacity), activeGroup === 'tools' ? 'auto' : 'none')
      setUi(aboutUi, aboutOpacity, groupScale(about, aboutOpacity), activeGroup === 'about' ? 'auto' : 'none')
      heroUi.style.zIndex = heroOpacity > 0.01 ? '12' : '10'
      toolsUi.style.zIndex = toolsOpacity > 0.01 ? '13' : '10'
      aboutUi.style.zIndex = aboutOpacity > 0.01 ? '14' : '10'
      jumpNav.style.setProperty('--home-jump-opacity', jumpIn.toFixed(3))
      jumpNav.style.setProperty(
        '--home-jump-intro-active',
        heroOpacity.toFixed(3),
      )
      jumpNav.style.setProperty(
        '--home-jump-tools-active',
        toolsOpacity.toFixed(3),
      )
      jumpNav.style.setProperty(
        '--home-jump-about-active',
        aboutOpacity.toFixed(3),
      )
      jumpNav.style.setProperty(
        '--home-jump-pointer-events',
        jumpIn > 0.2 ? 'auto' : 'none',
      )
    }
    const onScroll = () => {
      if (!ticking) {
        ticking = true
        requestAnimationFrame(update)
      }
    }

    alignGroundGrid()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', alignGroundGrid)
    update()
    return () => {
      disposed = true
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', alignGroundGrid)
    }
  }, [groundScrollFactor, tileSize])

  function startChat() {
    playSfx('click')
    // Jump into the most recent conversation if one exists rather than
    // spawning an empty tab; otherwise start fresh. Safe whether or not
    // weights are ready — the chat panel handles the loading state.
    if (order.length > 0) {
      setActive(order[0])
    } else {
      newConversation()
    }
    // setActive/newConversation set view='chat' inside the store; this hop
    // takes us off the landing page onto the app shell that renders it.
    navigate(ROUTES.app)
  }

  function openTool(view: 'lookup' | 'prereq' | 'planning') {
    playSfx('tab')
    setView(view)
    navigate(ROUTES.app)
  }

  // Route a wheel selection. 'chat' and 'calendar' are special-cased; every
  // other key is a 1:1 tool tab handled by openTool (the switch default narrows
  // item.key to openTool's union for us).
  function selectWheelItem(item: WheelItem) {
    switch (item.key) {
      case 'chat':
        startChat()
        break
      case 'calendar':
        playSfx('tab')
        setView('calendar')
        navigate(ROUTES.app)
        break
      default:
        openTool(item.key)
    }
  }

  function scrollToSection(top: number) {
    const scroller = scrollerRef.current
    if (!scroller) return

    if (scrollAnimRef.current !== null) {
      cancelAnimationFrame(scrollAnimRef.current)
      scrollAnimRef.current = null
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      scroller.scrollTop = top
      return
    }

    const startY = scroller.scrollTop
    const maxTop = scroller.scrollHeight - scroller.clientHeight
    const targetY = Math.max(0, Math.min(maxTop, top))
    const distance = targetY - startY
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
    const startTime = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - startTime) / SCROLL_TO_TOOLS_MS)
      scroller.scrollTop = startY + distance * easeOutCubic(t)
      scrollAnimRef.current = t < 1 ? requestAnimationFrame(step) : null
    }
    scroller.scrollTop = startY + distance * easeOutCubic(0.02)
    scrollAnimRef.current = requestAnimationFrame(step)
  }

  function scrollToBlocks() {
    playSfx('tab')
    const target = blocksRef.current
    if (!target) return
    scrollToSection(target.offsetTop)
  }

  function scrollToAbout() {
    playSfx('tab')
    const target = aboutRef.current
    if (!target) return
    scrollToSection(target.offsetTop)
  }

  function scrollToTop() {
    playSfx('tab')
    scrollToSection(0)
  }

  function forwardOverlayWheel(e: WheelEvent) {
    const scroller = scrollerRef.current
    if (!scroller) return
    e.preventDefault()
    scroller.scrollTop += e.deltaY
    scroller.scrollLeft += e.deltaX
  }

  return (
    <div ref={scrollerRef} className="h-screen w-full min-h-0 overflow-y-auto">
      <div
        ref={jumpNavRef}
        onWheelCapture={forwardOverlayWheel}
        className="home-jump-nav fixed left-5 top-1/2 z-30 hidden -translate-y-1/2 flex-col items-start gap-3 font-mono text-[0.625rem] uppercase tracking-[0.22em] text-fg-faint sm:flex"
      >
        <button
          type="button"
          onClick={scrollToTop}
          className="home-jump-link home-jump-link--intro"
        >
          Intro
        </button>
        <button
          type="button"
          onClick={scrollToBlocks}
          className="home-jump-link home-jump-link--tools"
        >
          Tools
        </button>
        <button
          type="button"
          onClick={scrollToAbout}
          className="home-jump-link home-jump-link--about"
        >
          About Me
        </button>
      </div>
      {/* ── Hero fold — fills the viewport on its own; everything else is
          below the fold ── */}
      <section
        ref={heroRef}
        className="relative flex min-h-screen flex-col items-center justify-center px-6 sm:px-10"
      >
        {/* Neon wireframe landscape: a synthwave perspective grid floor
            receding to a glowing horizon, with a soft sun behind it. Fixed to
            the viewport so the scene stays put while the page scrolls past it.
            The horizon (sun + line + floor) is pinned to the gap between the
            description and CTA via --horizon-y (set in a layout effect). The
            floor has no idle motion — it only streams forward as you scroll,
            via a compositor-only transform (see .home-landscape-* in
            index.css). Recolors per theme off --accent. */}
        <div
          ref={landscapeRef}
          aria-hidden
          className="home-landscape pointer-events-none fixed inset-0 overflow-hidden"
          style={
            {
              '--home-tile-size': `${tileSize}px`,
            } as CSSProperties
          }
        >
          <div className="home-landscape-sun home-glow" />
          <div className="home-landscape-horizon" />
          <div className="home-landscape-floor">
            <div className="home-landscape-plane">
              <div ref={streamerRef} className="home-landscape-streamer">
                <div className="home-landscape-grid" />
                <div className="home-grid-box-layer">
                  {visibleBoxes.map((box) => (
                    <GridBox
                      key={box.id}
                      box={box}
                      halfCylinderShellArcAngleDeg={
                        halfCylinderShellArcAngleDeg
                      }
                      tileSize={tileSize}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Hero copy + the cue that drops to the page-selection blocks,
            grouped so the whole stack centers as one — even space above the
            logo and below the cue. */}
        <div
          ref={heroUiRef}
          onWheelCapture={forwardOverlayWheel}
          className="home-scroll-layer fixed inset-0 z-10 flex flex-col items-center justify-center gap-16 px-6 sm:px-10"
        >
          <div className="flex max-w-2xl flex-col items-center gap-5 text-center">
            <img
              src={`${import.meta.env.BASE_URL}logo.png`}
              alt="Reodite"
              className="home-rise h-24 w-24"
              style={{
                animationDelay: '40ms',
                filter: 'drop-shadow(0 8px 28px var(--accent-soft))',
              }}
            />
            <span
              className="home-rise rounded-full border border-line bg-surface-soft px-3 py-1 font-mono text-[0.6875rem] uppercase tracking-[0.22em] text-fg-faint"
              style={{ animationDelay: '110ms' }}
            >
              UBC Vancouver · 2026/27
            </span>
            <h1
              className="home-rise text-4xl font-semibold tracking-tight sm:text-5xl"
              style={{ animationDelay: '180ms' }}
            >
              Welcome to <span className="text-accent">Reodite</span>
            </h1>
            <p
              ref={descRef}
              className="home-rise max-w-xl text-lg leading-relaxed text-fg-muted"
              style={{ animationDelay: '250ms' }}
            >
              Your personal academic advisor for UBC Vancouver — one place to
              explore courses, untangle prerequisites, and plan your degree. 
            </p>
              <p
              ref={descRef}
              className="home-rise max-w-xl text-lg leading-relaxed text-fg-muted"
              style={{ animationDelay: '350ms' }}
            >
              And guess what — its completely free
            </p>
          </div>

          {/* Scroll cue / button — jumps down to the page-selection blocks. */}
          <button
            ref={ctaRef}
            onClick={scrollToBlocks}
            aria-label="Scroll to tools"
            style={{ animationDelay: '340ms' }}
            className={`home-rise ${SCROLL_CUE_CLASS}`}
          >
            <span className="font-mono text-[0.6875rem] uppercase tracking-[0.22em]">
              Get started
            </span>
            <ChevronDownIcon className="h-5 w-5 animate-bounce" />
          </button>
        </div>
      </section>

      {/* ── Tool selection — its own full-viewport fold, mirroring the hero. A
          spinning pseudo-3D wheel of destinations; only the front (focused)
          card is clickable — the arrows / dots / ← → rotate the rest into
          place. overflow-x-clip keeps the off-center side cards from widening
          the page. ── */}
      <section aria-hidden className={DEAD_SCROLLSPACE_CLASS} />

      <section
        ref={blocksRef}
        className="relative flex min-h-screen flex-col items-center justify-center overflow-x-clip px-6 py-[10vh] sm:px-10"
      >
        <div
          ref={toolsUiRef}
          onWheelCapture={forwardOverlayWheel}
          className="home-scroll-layer home-scroll-layer--hidden fixed inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 sm:px-10"
        >
          <p className="font-mono text-[0.6875rem] uppercase tracking-[0.22em] text-fg-faint">
            Choose where to start
          </p>
          <ToolWheel onSelect={selectWheelItem} />
        </div>
      </section>

      <section aria-hidden className={DEAD_SCROLLSPACE_CLASS} />

      <section
        ref={aboutRef}
        className="relative flex min-h-screen flex-col items-center justify-center px-6 py-[10vh] sm:px-10"
      >
        <div
          ref={aboutUiRef}
          onWheelCapture={forwardOverlayWheel}
          className="home-scroll-layer home-scroll-layer--hidden fixed inset-0 z-10 flex flex-col items-center justify-center gap-8 px-6 text-center sm:px-10"
        >
          <div className="flex max-w-2xl flex-col items-center gap-5">
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.22em] text-fg-faint">
              About The Creator
            </p>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Hello!
            </h2>
            <p className="max-w-xl text-base leading-relaxed text-fg-muted">
              I'm Libo, a 2nd year who likes game design, sunsets, and solving problems. Check out my social media and contact info below ↓
            </p>
          </div>

          <footer className="flex flex-wrap items-center justify-center gap-3">
            {SOCIAL_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target={link.href.startsWith('mailto:') ? undefined : '_blank'}
                rel={
                  link.href.startsWith('mailto:')
                    ? undefined
                    : 'noreferrer noopener'
                }
                className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-soft px-3 py-1.5 font-mono text-[0.6875rem] uppercase tracking-[0.18em] text-fg-muted transition-colors hover:border-accent/50 hover:text-accent"
              >
                <SocialIcon label={link.label} />
                {link.label}
              </a>
            ))}
          </footer>
        </div>
      </section>
    </div>
  )
}
