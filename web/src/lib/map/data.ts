// Static-asset loader for the campus map. Reogent streams these from its
// backend (/api/geo/* + Meilisearch indices); here they're pre-derived JSON
// under public/data/map/ (see pipeline/build_map_data.py), fetched once and
// cached for the session. A failed fetch clears the cache slot so a retry
// can succeed.
import type { FeatureCollection } from 'geojson'
import type {
  AvailabilityDoc,
  BuildingDoc,
  LibRoomDoc,
  LngLat,
  PoiDoc,
  StudySpaceDoc,
} from './types'

const promises = new Map<string, Promise<unknown>>()

function fetchJson<T>(name: string): Promise<T> {
  const cached = promises.get(name)
  if (cached) return cached as Promise<T>
  const url = `${import.meta.env.BASE_URL}data/map/${name}`
  const p = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load ${name}: HTTP ${res.status}`)
      return res.json() as Promise<T>
    })
    .catch((e) => {
      promises.delete(name)
      throw e
    })
  promises.set(name, p)
  return p
}

export const getBuildingsGeo = () =>
  fetchJson<FeatureCollection>('buildings.geojson')
export const getWalkingRoutesGeo = () =>
  fetchJson<FeatureCollection>('walking-routes.geojson')
export const getBuildingEntrances = () =>
  fetchJson<Record<string, LngLat[]>>('building-entrances.json')
export const getBuildingIndex = () =>
  fetchJson<BuildingDoc[]>('buildings-index.json')
export const getPois = () => fetchJson<PoiDoc[]>('pois.json')
export const getStudySpaces = () =>
  fetchJson<StudySpaceDoc[]>('study-spaces.json')
export const getLibRooms = () => fetchJson<LibRoomDoc[]>('lib-rooms.json')
export const getAvailability = () =>
  fetchJson<AvailabilityDoc[]>('room-availability.json')
