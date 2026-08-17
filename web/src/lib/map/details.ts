// Building-popup details assembly: rooms (Find a Space), bookable library
// rooms with an availability summary, and POIs inside the footprint. Ports
// Reogent's src/server/building-details.ts (pure summarization) plus the
// /api/building/[code] route-handler joins, running over the static docs.
import { resolveBuilding } from './buildings'
import {
  getAvailability,
  getBuildingsGeo,
  getLibRooms,
  getPois,
  getStudySpaces,
} from './data'
import { pointInFeature, type BuildingFeature } from './geo'
import type {
  AvailabilityDoc,
  AvailabilityRoomCard,
  BuildingDetails,
  LibRoomDoc,
  PoiCard,
  PoiDoc,
  RoomCard,
  StudySpaceDoc,
} from './types'

const toDate = (s: string) => new Date(s.replace(' ', 'T')) // "YYYY-MM-DD HH:MM" is local time
const hhmm = (s: string | null) => (s && s.length >= 16 ? s.slice(11, 16) : null)

/**
 * Free-now / free-until / next-free per bookable room, evaluated against the
 * snapshot: today's intervals when the snapshot covers today, otherwise the
 * latest date present (so a stale snapshot still shows meaningful slots,
 * anchored to that day's start). `as_of` must always be surfaced by the UI.
 */
export function summarizeAvailability(
  libRooms: LibRoomDoc[],
  intervals: AvailabilityDoc[],
  now: Date,
): { as_of: string | null; rooms: AvailabilityRoomCard[] } | null {
  if (libRooms.length === 0 || intervals.length === 0) return null
  const today = now.toLocaleDateString('en-CA') // local YYYY-MM-DD, not UTC
  const dates = [
    ...new Set(intervals.map((a) => a.date).filter(Boolean)),
  ] as string[]
  const evalDate = dates.includes(today) ? today : dates.sort().at(-1)
  const evalNow = evalDate === today ? now : toDate(`${evalDate} 00:00`)

  const rooms = libRooms.map((room) => {
    const mine = intervals
      .filter((a) => a.eid === room.eid && a.date === evalDate)
      .sort((a, b) => a.start.localeCompare(b.start))
    const freeNow = mine.find(
      (a) =>
        a.state === 'free' &&
        toDate(a.start) <= evalNow &&
        (!a.end || evalNow <= toDate(a.end)),
    )
    const nextFree = mine.find(
      (a) => a.state === 'free' && toDate(a.start) > evalNow,
    )
    return {
      title: room.title,
      capacity: room.capacity,
      url: room.url,
      // LibCal thumbnails come protocol-relative ("//libapps…")
      thumbnail: room.thumbnail
        ? room.thumbnail.startsWith('//')
          ? `https:${room.thumbnail}`
          : room.thumbnail
        : null,
      freeNow: !!freeNow,
      freeUntil: freeNow ? hhmm(freeNow.end) : null,
      nextFree: nextFree ? hhmm(nextFree.start) : null,
    }
  })
  return {
    as_of: intervals.find((a) => a.collected_at)?.collected_at ?? null,
    rooms,
  }
}

export function toRoomCard(doc: StudySpaceDoc): RoomCard {
  return {
    name: doc.name ?? doc.title,
    capacity: doc.capacity,
    floor: doc.floor,
    layout: doc.layout,
    furniture: doc.furniture,
    photo: doc.photo,
    link: doc.link,
  }
}

export function toPoiCard(doc: PoiDoc): PoiCard {
  return {
    name: doc.name,
    service_type: doc.service_type,
    url: doc.url,
    photo: doc.photo,
    hours: doc.hours,
    contact: doc.contact,
  }
}

/** Everything the building popup shows for one building. A missing dataset
 *  degrades that section to empty instead of failing the popup. */
export async function getBuildingDetails(query: string): Promise<BuildingDetails> {
  const building = await resolveBuilding(query)
  const [spaces, libRooms, avail, pois, geo] = await Promise.all([
    getStudySpaces().catch(() => [] as StudySpaceDoc[]),
    getLibRooms().catch(() => [] as LibRoomDoc[]),
    getAvailability().catch(() => [] as AvailabilityDoc[]),
    getPois().catch(() => [] as PoiDoc[]),
    getBuildingsGeo().catch(() => null),
  ])

  const rooms = spaces
    .filter((s) => s.building_code === building.code)
    .slice(0, 50)
  const myLibRooms = libRooms
    .filter((r) => r.building_code === building.code)
    .slice(0, 50)
  const myAvail = avail.filter((a) => a.building_code === building.code)

  const footprint = geo?.features.find(
    (f) =>
      String(
        (f.properties as Record<string, unknown> | null)?.BLDG_CODE ?? '',
      ).toUpperCase() === building.code,
  ) as BuildingFeature | undefined
  const insidePois = footprint
    ? pois.filter((p) => pointInFeature(footprint, [p.lon, p.lat]))
    : []

  return {
    code: building.code,
    name: building.name,
    rooms: rooms.map(toRoomCard),
    pois: insidePois.map(toPoiCard),
    availability: summarizeAvailability(myLibRooms, myAvail, new Date()),
  }
}
