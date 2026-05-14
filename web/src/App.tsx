import { useEffect } from 'react'
import { ModelLoader } from './components/ModelLoader'
import { Sidebar } from './components/Sidebar'
import { Chat } from './components/Chat'
import { CourseLookup } from './components/CourseLookup'
import { PrereqTree } from './components/PrereqTree'
import { OtherPage } from './components/OtherPage'
import { useConversations } from './store/conversations'
import { useSettings } from './store/settings'
import { useMusicPlayer } from './lib/music'

export default function App() {
  // Sync the active theme to <html data-theme="..."> so the CSS variable
  // palette in index.css swaps as soon as the user picks a different theme
  // in OtherPage. Lives at the App root (above ModelLoader) so the splash
  // and any error fallback already render under the active theme.
  const theme = useSettings((s) => s.theme)
  const zoom = useSettings((s) => s.zoom)
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

  return (
    <ModelLoader>
      <Shell />
    </ModelLoader>
  )
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
    </div>
  )
}
