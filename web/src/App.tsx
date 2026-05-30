import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Home } from './components/Home'
import { Chat } from './components/Chat'
import { CourseLookup } from './components/CourseLookup'
import { PrereqTree } from './components/PrereqTree'
import { Planning } from './components/Planning'
import { OtherPage } from './components/OtherPage'
import { EasterEggToast } from './components/EasterEggToast'
import { useConversations } from './store/conversations'
import { useSettings } from './store/settings'
import { DEFAULT_MODEL_SIZE, useLLMLoader } from './store/llmLoader'
import { useMusicPlayer } from './lib/music'
import { ROUTES, useRoute, replaceRoute } from './lib/router'

export default function App() {
  // Sync the active theme to <html data-theme="..."> so the CSS variable
  // palette in index.css swaps as soon as the user picks a different theme
  // in OtherPage.
  const theme = useSettings((s) => s.theme)
  const zoom = useSettings((s) => s.zoom)
  const startLoad = useLLMLoader((s) => s.startLoad)
  const route = useRoute()
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])
  useEffect(() => {
    // index.css sets html font-size: 20px as the rem base; scale it by
    // the zoom % so every rem-sized utility (text, spacing, icons)
    // tracks the user's choice. Px-sized controls (slider thumb,
    // borders) stay fixed by design.
    document.documentElement.style.fontSize = `${(20 * zoom) / 100}px`
  }, [zoom])
  useEffect(() => {
    // Auto-load Qwen3.5 2B on mount — no user choice, no picker. Warm
    // visits hit the IndexedDB cache in ~1-3 s; first visits stream the
    // weights in the background while the user can poke around the
    // Home / Course Finder / Prereq Tree panels.
    void startLoad(DEFAULT_MODEL_SIZE)
  }, [startLoad])
  // Drive the SomaFM <audio> element from the persisted music settings, and
  // host the easter-egg toast (below) — both live ABOVE the route switch so a
  // playing station and a pending discovery survive navigation between the
  // landing page and the app shell instead of tearing down on each move.
  useMusicPlayer()
  useEffect(() => {
    // Canonicalize the bare base URL ("/UBCLLM/") to "/UBCLLM/home" so the
    // landing page has one stable address.
    if (route === '') replaceRoute(ROUTES.home)
  }, [route])

  // Two top-level pages: the app shell (sidebar + tool panels) on /app,
  // the standalone landing page everywhere else. Home deliberately renders
  // without the sidebar.
  return (
    <>
      {route === ROUTES.app ? <Shell /> : <Home />}
      {/* Floating discovery notice for new easter eggs — mounted above the
          route switch so it shows on both the landing page and the app. */}
      <EasterEggToast />
    </>
  )
}

function Shell() {
  const view = useConversations((s) => s.view)
  // Keep every panel mounted and toggle visibility instead of conditionally
  // rendering — this preserves each tool's local input + result state when
  // the user switches views (e.g. course lookup query stays put).
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
        <div className={view === 'chat' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <Chat />
        </div>
        <div className={view === 'lookup' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <CourseLookup />
        </div>
        <div className={view === 'prereq' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <PrereqTree />
        </div>
        <div className={view === 'planning' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <Planning />
        </div>
        <div className={view === 'other' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <OtherPage />
        </div>
      </main>
    </div>
  )
}
