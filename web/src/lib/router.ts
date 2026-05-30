import { useSyncExternalStore } from 'react'

// Minimal client-side router. The app has exactly two top-level routes:
//   home — the landing page, rendered WITHOUT the sidebar
//   app  — the sidebar shell that hosts the tool panels (chat/lookup/…)
// That's too little to justify pulling in react-router, so this is a ~40-line
// History-API store: navigate()/replaceRoute() push URLs, useRoute() lets
// components subscribe. Route names are centralized here so renaming one is a
// single-line change.
export const ROUTES = {
  home: 'home',
  app: 'app',
} as const

// import.meta.env.BASE_URL is the Vite `base` ("/UBCLLM/" on Pages, same in
// dev). A "route" is the path segment AFTER that base, slashes trimmed:
//   /UBCLLM/      -> ""      (App canonicalizes this to "home")
//   /UBCLLM/home  -> "home"
//   /UBCLLM/app   -> "app"
const BASE = import.meta.env.BASE_URL

function trim(s: string): string {
  return s.replace(/^\/+|\/+$/g, '')
}

function readRoute(): string {
  const path = window.location.pathname
  const rest = path.startsWith(BASE) ? path.slice(BASE.length) : path
  return trim(rest)
}

const listeners = new Set<() => void>()
function notify(): void {
  for (const l of listeners) l()
}

// Browser back/forward changes the URL without our code running — re-read and
// re-render subscribers when it does.
window.addEventListener('popstate', notify)

export function navigate(route: string): void {
  const next = trim(route)
  if (next === readRoute()) return
  window.history.pushState(null, '', BASE + next)
  notify()
}

export function replaceRoute(route: string): void {
  const next = trim(route)
  if (next === readRoute()) return
  window.history.replaceState(null, '', BASE + next)
  notify()
}

export function useRoute(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    readRoute,
  )
}
