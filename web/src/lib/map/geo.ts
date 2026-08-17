// Pure geometry helpers for the campus map: centroids, bounds, building
// lookup, and point-in-polygon. Ported from Reogent's src/lib/geo.ts.
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
  Position,
} from 'geojson'
import type { LngLat } from './types'

interface BuildingFeatureProperties {
  BLDG_CODE?: string
  NAME?: string
  [key: string]: unknown
}

export type BuildingFeature = Feature<
  Polygon | MultiPolygon,
  BuildingFeatureProperties
>

function isPolygonal(f: Feature): f is BuildingFeature {
  if (f.geometry?.type !== 'Polygon' && f.geometry?.type !== 'MultiPolygon')
    return false
  const coords = (f.geometry as Polygon | MultiPolygon).coordinates
  return Array.isArray(coords) && coords.length > 0
}

/** The exterior ring with the largest vertex count (largest ring of a MultiPolygon). */
function exteriorRing(geometry: Polygon | MultiPolygon): Position[] {
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0)
    return []
  if (geometry.type === 'Polygon') return geometry.coordinates[0] ?? []
  let best: Position[] = []
  for (const polygon of geometry.coordinates) {
    if (!Array.isArray(polygon)) continue
    const ring = polygon[0] ?? []
    if (ring.length > best.length) best = ring
  }
  return best
}

/**
 * Area-weighted centroid of the feature's exterior ring (shoelace formula,
 * computed in coordinates local to the first vertex — tiny footprints at
 * longitude ±120° lose meters of precision otherwise). Falls back to the
 * ring's vertex average for degenerate rings.
 */
export function featureCentroid(feature: BuildingFeature): LngLat | null {
  const ring = exteriorRing(feature.geometry)
  if (ring.length < 3) return null
  // Bail if any coordinate is non-finite
  if (!ring.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])))
    return null
  const [ox, oy] = ring[0]
  let area = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const x0 = ring[i][0] - ox
    const y0 = ring[i][1] - oy
    const x1 = ring[i + 1][0] - ox
    const y1 = ring[i + 1][1] - oy
    const cross = x0 * y1 - x1 * y0
    area += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  if (Math.abs(area) < 1e-18) {
    let sx = 0
    let sy = 0
    for (const [x, y] of ring) {
      sx += x
      sy += y
    }
    return [sx / ring.length, sy / ring.length]
  }
  return [ox + cx / (3 * area), oy + cy / (3 * area)]
}

/**
 * Find a building feature by identifier: exact BLDG_CODE match first
 * (case-insensitive), then a case-insensitive NAME substring match.
 */
export function findBuilding(
  collection: FeatureCollection,
  query: string,
): BuildingFeature | null {
  const q = query.trim().toUpperCase()
  if (!q) return null
  if (!Array.isArray(collection?.features)) return null
  const features = collection.features.filter(isPolygonal)
  const byCode = features.find(
    (f) => (f.properties?.BLDG_CODE ?? '').toUpperCase() === q,
  )
  if (byCode) return byCode
  return (
    features.find((f) => (f.properties?.NAME ?? '').toUpperCase().includes(q)) ??
    null
  )
}

/** Ray-cast point-in-ring test (even-odd rule). */
function pointInRing(point: LngLat, ring: Position[]): boolean {
  const [x, y] = point
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

/** True when the point lies inside the feature's footprint (holes excluded). */
export function pointInFeature(feature: BuildingFeature, point: LngLat): boolean {
  const polygons =
    feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates
  return polygons.some(
    (polygon) =>
      pointInRing(point, polygon[0] ?? []) &&
      !polygon.slice(1).some((hole) => pointInRing(point, hole)),
  )
}

export interface Bounds {
  west: number
  south: number
  east: number
  north: number
}

export function featuresBounds(features: BuildingFeature[]): Bounds | null {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const feature of features) {
    for (const [x, y] of exteriorRing(feature.geometry)) {
      if (x < west) west = x
      if (x > east) east = x
      if (y < south) south = y
      if (y > north) north = y
    }
  }
  if (!Number.isFinite(west)) return null
  return { west, south, east, north }
}

/**
 * Convex hull (Andrew monotone chain) over every polygon vertex in the
 * collection. Reogent ships this precomputed (data/campus-hull.json); here
 * it's derived once from the buildings GeoJSON after load — same result,
 * one fewer artifact. Drives the elastic pan boundary.
 */
export function convexHull(collection: FeatureCollection): LngLat[] {
  const pts: LngLat[] = []
  for (const f of collection.features) {
    if (!isPolygonal(f)) continue
    for (const [x, y] of exteriorRing(f.geometry)) {
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y])
    }
  }
  if (pts.length < 3) return pts
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: LngLat, a: LngLat, b: LngLat) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: LngLat[] = []
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    )
      lower.pop()
    lower.push(p)
  }
  const upper: LngLat[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    )
      upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}
