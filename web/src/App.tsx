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
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
        {view === 'chat' && <Chat />}
        {view === 'lookup' && <CourseLookup />}
        {view === 'prereq' && <PrereqTree />}
      </main>
    </div>
  )
}
