// Points-of-interest search for the campus map — the non-agentic port of
// Reogent's find_places tool: optional name keywords, optional service-type
// filter, optionally sorted by straight-line walk estimate from a building
// (same detour factor + speed as the routing fallback; only real routes use
// the path network).
import { resolveBuilding } from './buildings'
import { getPois } from './data'
import {
  ESTIMATE_DETOUR,
  haversineMetersObj,
  WALK_SPEED_M_PER_MIN,
  type BuildingDoc,
  type PoiDoc,
} from './types'

export type PoiWithWalk = PoiDoc & {
  walk_meters?: number
  walk_minutes?: number
}

export interface PlacesResult {
  near: BuildingDoc | null
  places: PoiWithWalk[]
}

/** The service types present in the dataset, for the filter dropdown. */
export async function listServiceTypes(): Promise<string[]> {
  const pois = await getPois()
  return [...new Set(pois.map((p) => p.service_type).filter((t): t is string => !!t))].sort()
}

export async function findPlaces(options: {
  query?: string
  serviceType?: string
  nearBuilding?: string
  limit?: number
}): Promise<PlacesResult> {
  const limit = Math.min(options.limit || 10, 30)
  const pois = await getPois()
  const q = (options.query ?? '').trim().toUpperCase()
  let results: PoiWithWalk[] = pois.filter((p) => {
    if (options.serviceType && p.service_type !== options.serviceType)
      return false
    if (!q) return true
    return (
      p.name.toUpperCase().includes(q) ||
      (p.abbreviation ?? '').toUpperCase().includes(q)
    )
  })
  let near: BuildingDoc | null = null
  if (options.nearBuilding?.trim()) {
    near = await resolveBuilding(options.nearBuilding)
    const from = near
    results = results
      .map((p) => {
        const walk_meters = Math.round(
          haversineMetersObj(from, p) * ESTIMATE_DETOUR,
        )
        return {
          ...p,
          walk_meters,
          walk_minutes: Math.ceil(walk_meters / WALK_SPEED_M_PER_MIN),
        }
      })
      .sort((a, b) => a.walk_meters! - b.walk_meters!)
  }
  return { near, places: results.slice(0, limit) }
}
