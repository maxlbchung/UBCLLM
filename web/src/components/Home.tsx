import { useRef, type ComponentType } from 'react'
import { useConversations } from '../store/conversations'
import { ROUTES, navigate } from '../lib/router'
import { playSfx } from '../lib/sfx'
import { CalendarWidget } from './CalendarWidget'
import {
  ChatIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GradCapIcon,
  GraphIcon,
  SearchIcon,
  type IconProps,
} from './icons'

// Landing page. The model auto-loads on startup (App.tsx fires
// useLLMLoader.startLoad unconditionally), so this page is purely a front
// door: a calm full-screen welcome, then a 4-up grid that selects each tool
// (Ask AI + the three companion tools).
//
// Layout intent: the hero is its own full-viewport fold (min-h-screen), so
// the page-selection grid lives in the *next* section and starts just past
// the fold — out of view on load, reached by the hero's "Get started" cue
// (or by scrolling). Offsets are vh-based so they stay proportional to the
// screen. The calendar sits a further section down.

const TOOLS: {
  view: 'lookup' | 'prereq' | 'planning'
  Icon: ComponentType<IconProps>
  title: string
  desc: string
}[] = [
  {
    view: 'lookup',
    Icon: SearchIcon,
    title: 'Course Finder',
    desc: 'Search and filter the full UBC course catalogue by code, subject, or level.',
  },
  {
    view: 'prereq',
    Icon: GraphIcon,
    title: 'Prerequisite Visualizer',
    desc: 'See a full prerequisite graph to build a path to your desired courses.',
  },
  {
    view: 'planning',
    Icon: GradCapIcon,
    title: 'Degree Planner',
    desc: 'Build a multi-year schedule and check it against your program requirements.',
  },
]

const CARD_CLASS =
  'home-rise group relative flex flex-col items-start gap-4 overflow-hidden rounded-2xl border border-line bg-surface-soft p-6 text-left transition-[transform,border-color,background-color,box-shadow] duration-200 hover:-translate-y-1 hover:border-accent/40 hover:bg-surface-raised hover:shadow-xl hover:shadow-black/10'

const ICON_TILE_CLASS =
  'flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-accent transition-colors duration-200 group-hover:bg-accent group-hover:text-accent-fg'

const CARD_CHEVRON_CLASS =
  'absolute right-5 top-6 h-4 w-4 -translate-x-1 text-fg-faint opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:text-accent group-hover:opacity-100'

const SCROLL_CUE_CLASS =
  'group flex flex-col items-center gap-1.5 text-fg-faint transition-colors hover:text-accent'

export function Home() {
  const newConversation = useConversations((s) => s.newConversation)
  const setView = useConversations((s) => s.setView)
  const order = useConversations((s) => s.order)
  const setActive = useConversations((s) => s.setActive)

  const blocksRef = useRef<HTMLElement>(null)
  const calendarRef = useRef<HTMLElement>(null)

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

  function scrollToBlocks() {
    playSfx('tab')
    blocksRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function scrollToCalendar() {
    playSfx('tab')
    calendarRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="h-screen w-full min-h-0 overflow-y-auto">
      {/* ── Hero fold — fills the viewport on its own; everything else is
          below the fold ── */}
      <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 sm:px-10">
        {/* Neon wireframe landscape: a synthwave perspective grid floor
            receding to a glowing horizon, with a soft sun breathing behind
            it. The floor scrolls toward the viewer via a compositor-only
            transform (see .home-landscape-* in index.css). Recolors per
            theme off --accent, so the "neon" follows the active palette. */}
        <div
          aria-hidden
          className="home-landscape pointer-events-none absolute inset-0"
        >
          <div className="home-landscape-sun home-glow" />
          <div className="home-landscape-horizon" />
          <div className="home-landscape-floor">
            <div className="home-landscape-plane">
              <div className="home-landscape-grid home-landscape-grid--glow" />
              <div className="home-landscape-grid" />
            </div>
          </div>
        </div>

        {/* Hero copy + the cue that drops to the page-selection blocks,
            grouped so the whole stack centers as one — even space above the
            logo and below the cue. */}
        <div className="relative z-10 flex flex-col items-center gap-16">
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
              className="home-rise max-w-xl text-lg leading-relaxed text-fg-muted"
              style={{ animationDelay: '250ms' }}
            >
              Your personal AI academic advisor for UBC Vancouver — one place to
              explore courses, untangle prerequisites, and plan your degree.
            </p>
          </div>

          {/* Scroll cue / button — jumps down to the page-selection blocks. */}
          <button
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

      {/* ── Page selection — its own full-viewport fold, mirroring the hero:
          one centered group (2×2 grid + cue) with even top/bottom padding. It
          begins just past the fold and fills the screen when reached. ── */}
      <section
        ref={blocksRef}
        className="relative flex min-h-screen flex-col items-center justify-center px-6 py-[10vh] sm:px-10"
      >
        <div className="flex w-full max-w-3xl flex-col items-center gap-16">
          <div className="grid w-full grid-cols-1 gap-5 sm:grid-cols-2">
            {/* Ask AI — the chat entry. */}
            <button onClick={startChat} className={CARD_CLASS}>
              <span className={ICON_TILE_CLASS}>
                <ChatIcon className="h-6 w-6" />
              </span>
              <span className="flex items-center gap-2 text-base font-semibold">
                Ask AI
                <span className="rounded-full border border-highlight/40 px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-wider text-highlight">
                  Beta
                </span>
              </span>
              <span className="text-sm leading-relaxed text-fg-muted">
                Chat about UBC courses, programs, and faculties.
              </span>
              <ChevronRightIcon className={CARD_CHEVRON_CLASS} />
            </button>

            {/* Companion tools */}
            {TOOLS.map((t) => (
              <button
                key={t.view}
                onClick={() => openTool(t.view)}
                className={CARD_CLASS}
              >
                <span className={ICON_TILE_CLASS}>
                  <t.Icon className="h-6 w-6" />
                </span>
                <span className="text-base font-semibold">{t.title}</span>
                <span className="text-sm leading-relaxed text-fg-muted">
                  {t.desc}
                </span>
                <ChevronRightIcon className={CARD_CHEVRON_CLASS} />
              </button>
            ))}
          </div>

          {/* Scroll cue / button — continues down to the campus calendar. */}
          <button
            onClick={scrollToCalendar}
            aria-label="Scroll to upcoming UBC dates"
            className={SCROLL_CUE_CLASS}
          >
            <span className="font-mono text-[0.6875rem] uppercase tracking-[0.22em]">
              Upcoming at UBC
            </span>
            <ChevronDownIcon className="h-5 w-5 animate-bounce" />
          </button>
        </div>
      </section>

      {/* ── Below: campus calendar ── */}
      <section
        ref={calendarRef}
        className="mx-auto w-full max-w-6xl scroll-mt-6 px-6 pb-24 sm:px-10"
      >
        <CalendarWidget />
      </section>
    </div>
  )
}
