// Shared types + walking constants for the campus map tool. Ported from
// Reogent (src/shared/types.ts + module doc types), minus the agentic
// tool-calling contract — the same data shapes now feed a hand-driven UI
// instead of LLM tool results.

/** Coordinate tuple in GeoJSON order: [longitude, latitude]. */
export type LngLat = [number, number]

/** Great-circle distance in meters (Haversine formula). */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * sinLng * sinLng
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Haversine overload accepting {lat, lon} objects. */
export function haversineMetersObj(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  return haversineMeters([a.lon, a.lat], [b.lon, b.lat])
}

// Walking constants (same values as Reogent's routing + estimates)
export const WALK_SPEED_M_PER_MIN = 80
export const ESTIMATE_DETOUR = 1.3

/** Searchable building doc from buildings-index.json. */
export interface BuildingDoc {
  code: string
  name: string
  /** Acronym aliases (e.g. "IKB" for Irving K. Barber) — colloquial codes
   *  that aren't the official BLDG_CODE. */
  aliases: string[]
  lat: number
  lon: number
}

/** Point of interest from pois.json. */
export interface PoiDoc {
  id: string
  name: string
  abbreviation: string | null
  service_type: string | null // cafe, restaurant, library, grocery, bank, ...
  url: string | null
  contact: string | null
  hours: string | null // free text — display verbatim, never parse
  photo: string | null
  lat: number
  lon: number
}

/** Classroom / informal study space from study-spaces.json (Find a Space). */
export interface StudySpaceDoc {
  id: string
  title: string
  name: string | null // short label, e.g. "AERL 120"
  building_code: string | null
  building_name: string | null
  room_number: string | null
  capacity: number | null
  space_type: string | null // "classroom" | "study space"
  furniture: string | null
  layout: string | null
  floor: number | null
  photo: string | null // cover thumbnail (signed URL — may go stale)
  link: string | null // Find a Space room page
}

/** Bookable library room (LibCal catalog) — joins room availability by eid. */
export interface LibRoomDoc {
  eid: number
  building_code: string | null
  location: string | null
  title: string
  capacity: number | null
  url: string | null
  thumbnail: string | null
}

/** One free/booked interval from the room-availability snapshot. */
export interface AvailabilityDoc {
  eid: number
  location: string | null
  building_code: string | null
  room: string
  capacity: number | null
  state: 'free' | 'booked' | 'unavailable'
  date: string | null
  start: string
  end: string | null
  minutes: number | null
  collected_at: string | null // snapshot time — always surface as "as of"
}

// ---- Building-popup card shapes (Reogent's api-types) ----

export interface RoomCard {
  name: string
  capacity: number | null
  floor: number | null
  layout: string | null
  furniture: string | null
  photo: string | null
  link: string | null
}

export interface AvailabilityRoomCard {
  title: string
  capacity: number | null
  url: string | null
  thumbnail: string | null
  freeNow: boolean
  freeUntil: string | null
  nextFree: string | null
}

export interface PoiCard {
  name: string
  service_type: string | null
  url: string | null
  photo: string | null
  hours: string | null
  contact: string | null
}

export interface BuildingDetails {
  code: string
  name: string
  rooms: RoomCard[]
  pois: PoiCard[]
  availability: { as_of: string | null; rooms: AvailabilityRoomCard[] } | null
}

// ---- Map highlight state (Reogent's walking.ts shapes, sans tool-calls) ----

export interface WalkingHighlight {
  kind: 'route'
  /** Canonical BLDG_CODEs of the resolved endpoints. */
  from: string
  to: string
  meters: number
  minutes: number
}

export interface BuildingRef {
  code: string
  name: string
  lat: number
  lon: number
}

export interface BuildingsHighlight {
  kind: 'buildings'
  buildings: BuildingRef[]
}

export interface PlacePin {
  name: string
  lat: number
  lon: number
  service_type: string | null
}

export interface PlacesHighlight {
  kind: 'places'
  /** Building code the search was anchored to, when given. */
  near: string | null
  places: PlacePin[]
}

/** What the campus map renders: a walking route, focused buildings, or POI pins. */
export type MapHighlight = WalkingHighlight | BuildingsHighlight | PlacesHighlight
