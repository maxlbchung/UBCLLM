// Distance/time formatting for the campus map (from Reogent's lib/format.ts).

export function formatMeters(meters: number): string {
  if (!Number.isFinite(meters)) return '—'
  if (meters >= 1000) {
    const km = meters / 1000
    return `${km.toFixed(km >= 10 ? 0 : 1)} km`
  }
  return `${Math.round(meters)} m`
}

export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) return '—'
  const rounded = Math.max(1, Math.round(minutes))
  return `${rounded} min`
}
