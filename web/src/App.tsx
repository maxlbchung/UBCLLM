import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Home } from './components/Home'
import { Chat } from './components/Chat'
import { CourseLookup } from './components/CourseLookup'
import { PrereqTree } from './components/PrereqTree'
import { OtherPage } from './components/OtherPage'
import { EasterEggToast } from './components/EasterEggToast'
import { useConversations } from './store/conversations'
import { useSettings } from './store/settings'
import { DEFAULT_MODEL_SIZE, useLLMLoader } from './store/llmLoader'
import { useMusicPlayer } from './lib/music'

export default function App() {
  // Sync the active theme to <html data-theme="..."> so the CSS variable
  // palette in index.css swaps as soon as the user picks a different theme
  // in OtherPage.
  const theme = useSettings((s) => s.theme)
  const zoom = useSettings((s) => s.zoom)
  const startLoad = useLLMLoader((s) => s.startLoad)
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
    // Home / Course Lookup / Prereq Tree panels.
    void startLoad(DEFAULT_MODEL_SIZE)
  }, [startLoad])

  return <Shell />
}

function Shell() {
  const view = useConversations((s) => s.view)
  // Drive the SomaFM <audio> element from the persisted music settings.
  // Mounted here (not inside OtherPage) so a playing station survives
  // view changes — the user can leave music running while they bounce
  // between chat, lookup, and prereq panels.
  useMusicPlayer()
  // Keep every panel mounted and toggle visibility instead of conditionally
  // rendering — this preserves each tool's local input + result state when
  // the user switches views (e.g. course lookup query stays put).
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
        <div className={view === 'home' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <Home />
        </div>
        <div className={view === 'chat' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <Chat />
        </div>
        <div className={view === 'lookup' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <CourseLookup />
        </div>
        <div className={view === 'prereq' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <PrereqTree />
        </div>
        <div className={view === 'other' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <OtherPage />
        </div>
      </main>
      {/* Floating discovery notice for new easter eggs. Lives at the
          shell level so it appears regardless of which view is active. */}
      <EasterEggToast />
    </div>
  )
}
