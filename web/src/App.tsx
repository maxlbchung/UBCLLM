import { ModelLoader } from './components/ModelLoader'
import { Sidebar } from './components/Sidebar'
import { Chat } from './components/Chat'
import { CourseLookup } from './components/CourseLookup'
import { PrereqTree } from './components/PrereqTree'
import { useConversations } from './store/conversations'

export default function App() {
  return (
    <ModelLoader>
      <Shell />
    </ModelLoader>
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
      </main>
    </div>
  )
}
