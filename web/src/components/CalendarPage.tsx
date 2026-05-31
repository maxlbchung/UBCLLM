import { CalendarWidget } from './CalendarWidget'

// App-shell host for the campus calendar. No card chrome, no max-width — the
// widget fills the whole tab and sizes its month grid to the available height
// (see CalendarWidget) so it fits the viewport instead of spilling below it.
export function CalendarPage() {
  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <CalendarWidget />
    </div>
  )
}
