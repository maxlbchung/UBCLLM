// CampusMap: deck.gl v9 layers over a MapLibre basemap, ported from Reogent's
// campus map (src/components/map/campus-map.tsx) minus the agent plumbing —
// the highlight that drives it comes from the Campus Map tool's own controls
// (find building / walking route / find places) instead of LLM tool calls.
//
// Buildings come from the static buildings.geojson (derived from
// Reodite/ubc-unified-data by pipeline/build_map_data.py) extruded to their
// real heights (BLDG_HEIGHT / MAX_FLOORS), with a pick-tooltip showing
// NAME / BLDG_CODE; walking routes are an optional context layer. A route
// highlight traces the actual pedestrian-network polyline (Dijkstra over the
// same static network, in-browser) with a draw-on animation; a building
// highlight lights the footprint and flies to it.
//
// maplibre + deck are imported dynamically inside the init effect so the ~1 MB
// of map code stays out of the initial bundle.
import type { FeatureCollection } from 'geojson'
import { useEffect, useRef, useState } from 'react'
import { resolveBuilding } from '../../lib/map/buildings'
import { getBuildingsGeo, getWalkingRoutesGeo } from '../../lib/map/data'
import { formatMeters, formatMinutes } from '../../lib/map/format'
import {
  convexHull,
  featureCentroid,
  featuresBounds,
  findBuilding,
  type BuildingFeature,
} from '../../lib/map/geo'
import { route as computeRoute } from '../../lib/map/routing'
import type { LngLat, MapHighlight } from '../../lib/map/types'
import { useSettings } from '../../store/settings'
import { BuildingPopup, type SelectedBuilding } from './BuildingPopup'

export type MapStatus = 'loading' | 'ready' | 'error'

export interface MapControls {
  zoomIn: () => void
  zoomOut: () => void
  resetView: () => void
}

/** The map renders on a light or dark basemap; the app's four themes resolve
 *  to one of the two (only `light` is a light palette). */
type ResolvedTheme = 'light' | 'dark'

interface CampusMapProps {
  highlight: MapHighlight | null
  /** Bumps re-focus the camera on the current highlight. */
  focusNonce: number
  showRoutes: boolean
  onStatus?: (status: MapStatus) => void
  /** Filled with imperative camera controls once the map is up. */
  controls?: React.RefObject<MapControls | null>
}

interface PickedBuilding {
  name: string
  code: string
  x: number
  y: number
}

const TOOLTIP_OFFSET = 12

/** Position the building tooltip, flipping anchor when it would overflow the container. */
function tooltipPosition(
  picked: PickedBuilding,
  container: HTMLDivElement | null,
): React.CSSProperties {
  const w = container?.clientWidth ?? 800
  const h = container?.clientHeight ?? 600

  const fitsRight = picked.x + TOOLTIP_OFFSET + 240 < w
  const fitsBelow = picked.y + TOOLTIP_OFFSET + 56 < h

  return {
    // Fits right: tooltip starts offset to the right of cursor
    // Doesn't fit: tooltip ends offset to the left of cursor (right edge near cursor)
    left: fitsRight ? picked.x + TOOLTIP_OFFSET : undefined,
    right: fitsRight ? undefined : w - picked.x + TOOLTIP_OFFSET,
    top: fitsBelow ? picked.y + TOOLTIP_OFFSET : undefined,
    bottom: fitsBelow ? undefined : h - picked.y + TOOLTIP_OFFSET,
  }
}

const UBC_CENTER: LngLat = [-123.246, 49.2626]
const INITIAL_VIEW = { center: UBC_CENTER, zoom: 14.4, pitch: 40, bearing: -8 }

const PAN_BUFFER_DEG = 0.0045 // ~0.5km buffer from hull edge

/** Signed distance from point to hull. Negative = inside, positive = outside. */
function distToHull(hull: LngLat[], lng: number, lat: number): number {
  // Point-in-polygon (ray casting)
  let inside = false
  for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
    const [xi, yi] = hull[i]
    const [xj, yj] = hull[j]
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  // Distance to nearest edge segment
  let minDist = Infinity
  for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
    const [ax, ay] = hull[j]
    const [bx, by] = hull[i]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t =
      len2 > 0
        ? Math.max(0, Math.min(1, ((lng - ax) * dx + (lat - ay) * dy) / len2))
        : 0
    const px = ax + t * dx
    const py = ay + t * dy
    const d = Math.sqrt((lng - px) ** 2 + (lat - py) ** 2)
    if (d < minDist) minDist = d
  }
  return inside ? -minDist : minDist
}

const STYLE_URLS: Record<ResolvedTheme, string> = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
}

type Rgba = [number, number, number, number]

// ---- Map color system ----
// Same structure as Reogent's (buildings as a flat raised surface, highlights
// and routes on the accent), remapped onto this app's palette: accent blue
// #2563eb in light, blue-400 #60a5fa in dark; basemap tints blend with
// --canvas from index.css.
const MAP_COLORS: Record<
  ResolvedTheme,
  Record<
    | 'fill'
    | 'line'
    | 'fillHighlight'
    | 'lineHighlight'
    | 'route'
    | 'routeCasing'
    | 'label'
    | 'labelBg'
    | 'walkway',
    Rgba
  >
> = {
  light: {
    // Buildings
    fill: [190, 190, 197, 255],
    line: [195, 196, 202, 255],
    // Highlighted: accent blue-600 #2563eb
    fillHighlight: [37, 99, 235, 220],
    lineHighlight: [30, 58, 138, 255],
    // Route: accent blue-600
    route: [37, 99, 235, 235],
    routeCasing: [250, 250, 250, 190],
    // Labels: fg-muted for legibility without heaviness
    label: [82, 82, 91, 255],
    labelBg: [250, 250, 250, 215],
    // Walkways: accent at 25%
    walkway: [37, 99, 235, 64],
  },
  dark: {
    // Buildings
    fill: [9, 9, 11, 255],
    line: [63, 63, 70, 255],
    // Highlighted: blue-400 #60a5fa
    fillHighlight: [96, 165, 250, 220],
    lineHighlight: [191, 219, 254, 255],
    // Route: blue-400
    route: [96, 165, 250, 220],
    routeCasing: [11, 13, 18, 190],
    // Labels: fg-muted (dark) for clarity
    label: [161, 161, 170, 255],
    labelBg: [14, 14, 16, 215],
    // Walkways: accent at 25%
    walkway: [96, 165, 250, 64],
  },
}

const ROUTE_DRAW_MS = 2500

// Basemap layer overrides: makes CARTO tiles seamless with the app shell.
// Positron (light) gets matched to --canvas; Dark Matter loses its black.
const BASEMAP_OVERRIDES: Record<
  ResolvedTheme,
  {
    background: string
    landcover: string
    water: string
    road: string
    roadMinor: string
  }
> = {
  light: {
    background: '#fafafa', // --canvas (light)
    landcover: '#eff2ee', // hint of life, barely-there warm green
    water: '#e2e6ee', // cool blue-gray
    road: '#eaeaec', // --line adjacent — hairline dividers
    roadMinor: '#f0f0f2', // even subtler for small paths
  },
  dark: {
    background: '#0e1015', // between --canvas #0b0d12 and --surface
    landcover: '#12141a', // barely differentiated, no tint
    water: '#090b10', // dark, not black — subtle depth
    road: '#1b1e26', // --line adjacent
    roadMinor: '#14161d', // ghostly
  },
}

function patchBasemapColors(
  map: import('maplibre-gl').Map,
  resolvedTheme: ResolvedTheme,
) {
  const ov = BASEMAP_OVERRIDES[resolvedTheme]
  try {
    const style = map.getStyle()
    if (!style?.layers) return
    for (const layer of style.layers) {
      const id = layer.id
      if (id === 'background' && layer.type === 'background') {
        map.setPaintProperty(id, 'background-color', ov.background)
      } else if (layer.type === 'fill') {
        if (id.includes('water')) {
          map.setPaintProperty(id, 'fill-color', ov.water)
        } else if (
          id.includes('landcover') ||
          id.includes('landuse') ||
          id.includes('park')
        ) {
          map.setPaintProperty(id, 'fill-color', ov.landcover)
        } else if (id.includes('building')) {
          // Hide basemap flat buildings — deck.gl renders them in 3D
          map.setPaintProperty(id, 'fill-opacity', 0)
        }
      } else if (layer.type === 'line') {
        if (id.includes('road') || id.includes('highway') || id.includes('street')) {
          if (id.includes('path') || id.includes('pedestrian')) continue
          const isMinor = id.includes('minor') || id.includes('service')
          map.setPaintProperty(id, 'line-color', isMinor ? ov.roadMinor : ov.road)
        }
      }
    }
  } catch {
    // Non-critical — deck.gl layers render regardless of basemap tinting
  }
}

/** Real height where the dataset has one; ~3.5 m per floor otherwise; low default. */
function buildingHeight(feature: BuildingFeature): number {
  const p = feature.properties ?? {}
  return Number(p.BLDG_HEIGHT) || (Number(p.MAX_FLOORS) || 0) * 3.5 || 8
}

interface MapHandles {
  map: import('maplibre-gl').Map
  overlay: import('@deck.gl/mapbox').MapboxOverlay
  layerModules: {
    GeoJsonLayer: typeof import('@deck.gl/layers').GeoJsonLayer
    PathLayer: typeof import('@deck.gl/layers').PathLayer
    ScatterplotLayer: typeof import('@deck.gl/layers').ScatterplotLayer
    TextLayer: typeof import('@deck.gl/layers').TextLayer
  }
  gradientExtension: import('@deck.gl/core').LayerExtension
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Resolve the highlighted route pair to features + centroids; null when unmatchable. */
function resolveRoute(
  buildings: FeatureCollection | null,
  highlight: MapHighlight | null,
) {
  if (!buildings || highlight?.kind !== 'route') return null
  const from = findBuilding(buildings, highlight.from)
  const to = findBuilding(buildings, highlight.to)
  if (!from || !to) return null
  const fromCenter = featureCentroid(from)
  const toCenter = featureCentroid(to)
  if (!fromCenter || !toCenter) return null
  return { from, to, fromCenter, toCenter }
}

/** The first `t` (0..1) of the path, vertex-paced with the tip interpolated —
 *  drives the draw-on animation without TripsLayer. */
function partialPath(path: LngLat[], t: number): LngLat[] {
  if (t >= 1 || path.length < 2) return path
  const progress = (path.length - 1) * Math.max(0, t)
  const i = Math.floor(progress)
  const frac = progress - i
  const out = path.slice(0, i + 1)
  if (frac > 0 && i + 1 < path.length) {
    const [x0, y0] = path[i]
    const [x1, y1] = path[i + 1]
    out.push([x0 + (x1 - x0) * frac, y0 + (y1 - y0) * frac])
  }
  return out
}

const LABEL_FONT = 'ui-sans-serif, system-ui, sans-serif'

export function CampusMap({
  highlight,
  focusNonce,
  showRoutes,
  onStatus,
  controls,
}: CampusMapProps) {
  const appTheme = useSettings((s) => s.theme)
  const theme: ResolvedTheme = appTheme === 'light' ? 'light' : 'dark'

  const containerRef = useRef<HTMLDivElement>(null)
  const handlesRef = useRef<MapHandles | null>(null)
  const appliedStyleRef = useRef<ResolvedTheme | null>(null)
  const didPanRef = useRef(false)
  // Campus convex hull for the elastic pan boundary — computed from the
  // buildings GeoJSON once it arrives (Reogent ships it precomputed; same
  // result). Empty until then, which disables the boundary.
  const hullRef = useRef<LngLat[]>([])
  const [status, setStatus] = useState<MapStatus>('loading')
  const [buildings, setBuildings] = useState<FeatureCollection | null>(null)
  const [walkingRoutes, setWalkingRoutes] = useState<FeatureCollection | null>(
    null,
  )
  const [picked, setPicked] = useState<PickedBuilding | null>(null)
  /** Building whose details popup is open (click/tap on a footprint). */
  const [selected, setSelected] = useState<SelectedBuilding | null>(null)
  /** Pedestrian-network polyline for the current route highlight. */
  const [routePath, setRoutePath] = useState<{
    key: string
    path: LngLat[]
  } | null>(null)
  const [drawProgress, setDrawProgress] = useState(1)

  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  useEffect(() => {
    onStatusRef.current?.(status)
  }, [status])

  // ---- Init: map + overlay (once) ----
  useEffect(() => {
    let disposed = false
    const container = containerRef.current
    if (!container) return

    ;(async () => {
      try {
        const [maplibre, { MapboxOverlay }, layers, core] = await Promise.all([
          import('maplibre-gl'),
          import('@deck.gl/mapbox'),
          import('@deck.gl/layers'),
          import('@deck.gl/core'),
          import('maplibre-gl/dist/maplibre-gl.css'),
        ])
        if (disposed) return

        const initialTheme: ResolvedTheme =
          document.documentElement.getAttribute('data-theme') === 'light'
            ? 'light'
            : 'dark'
        appliedStyleRef.current = initialTheme
        const map = new maplibre.Map({
          container,
          style: STYLE_URLS[initialTheme],
          center: INITIAL_VIEW.center,
          zoom: INITIAL_VIEW.zoom,
          pitch: INITIAL_VIEW.pitch,
          bearing: INITIAL_VIEW.bearing,
          minZoom: 13,
          maxZoom: 18,
          attributionControl: false,
        })
        // Bottom-left keeps the required attribution clear of the zoom stack.
        map.addControl(
          new maplibre.AttributionControl({ compact: true }),
          'bottom-left',
        )

        // Elastic circular boundary: custom drag with rubber-band physics.
        // MapLibre's dragPan is disabled to avoid setCenter fights.
        // All animation uses jumpTo + rAF to avoid MapLibre's internal ease system.
        map.dragPan.disable()

        /** How far past the allowed boundary (hull + buffer). 0 = inside, positive = overshoot. */
        const overshootFromBoundary = (lng: number, lat: number): number => {
          const hull = hullRef.current
          if (hull.length < 3) return 0
          return Math.max(0, distToHull(hull, lng, lat) - PAN_BUFFER_DEG)
        }

        const canvasEl = map.getCanvasContainer()
        let dragging = false
        let lastPt = { x: 0, y: 0 }
        let vel = { x: 0, y: 0 }
        let lastT = 0
        let animating = false

        function snapBack() {
          const c = map.getCenter()
          const overshoot = overshootFromBoundary(c.lng, c.lat)
          const hull = hullRef.current
          if (overshoot <= 0 || hull.length < 3) {
            animating = false
            return
          }
          // Find nearest point on the boundary (hull + buffer) by moving toward hull center
          const hullCenterLng = hull.reduce((s, p) => s + p[0], 0) / hull.length
          const hullCenterLat = hull.reduce((s, p) => s + p[1], 0) / hull.length
          const dx = c.lng - hullCenterLng
          const dy = c.lat - hullCenterLat
          const dist = Math.sqrt(dx * dx + dy * dy)
          // Target: pull back toward hull center by overshoot amount
          const pullRatio = Math.max(0, 1 - overshoot / dist)
          const targetLng = hullCenterLng + dx * pullRatio
          const targetLat = hullCenterLat + dy * pullRatio

          animating = true
          const startLng = c.lng
          const startLat = c.lat
          const startTime = performance.now()
          const duration = 250
          ;(function animate() {
            if (dragging) {
              animating = false
              return
            }
            const t = Math.min((performance.now() - startTime) / duration, 1)
            const ease = 1 - (1 - t) ** 3
            const lng = startLng + (targetLng - startLng) * ease
            const lat = startLat + (targetLat - startLat) * ease
            map.jumpTo({ center: [lng, lat] })
            if (t < 1) requestAnimationFrame(animate)
            else animating = false
          })()
        }

        canvasEl.addEventListener('pointerdown', (e) => {
          if (e.button !== 0 || e.ctrlKey || e.metaKey) return
          dragging = true
          didPanRef.current = false
          animating = false
          lastPt = { x: e.clientX, y: e.clientY }
          lastT = performance.now()
          vel = { x: 0, y: 0 }
          canvasEl.setPointerCapture(e.pointerId)
        })

        canvasEl.addEventListener('pointermove', (e) => {
          if (!dragging) return
          didPanRef.current = true
          const now = performance.now()
          const dt = now - lastT
          let dx = e.clientX - lastPt.x
          let dy = e.clientY - lastPt.y
          if (dt > 0) vel = { x: dx / dt, y: dy / dt }
          lastPt = { x: e.clientX, y: e.clientY }
          lastT = now

          // Dampen pixel movement when past the hull boundary
          const c = map.getCenter()
          const overshoot = overshootFromBoundary(c.lng, c.lat)
          if (overshoot > 0) {
            const dampen = 1 / (1 + (overshoot / PAN_BUFFER_DEG) * 4)
            dx *= dampen
            dy *= dampen
          }

          const cur = map.project(c)
          const target = map.unproject([cur.x - dx, cur.y - dy])
          map.jumpTo({ center: [target.lng, target.lat] })
        })

        function endDrag(e: PointerEvent) {
          if (!dragging) return
          dragging = false
          canvasEl.releasePointerCapture(e.pointerId)

          const c = map.getCenter()
          if (overshootFromBoundary(c.lng, c.lat) > 0) {
            snapBack()
            return
          }

          // Inside boundary: apply inertia coast
          const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y)
          if (speed > 0.05) {
            animating = true
            let vx = vel.x
            let vy = vel.y
            const decay = 0.93
            ;(function coast() {
              if (dragging) {
                animating = false
                return
              }
              vx *= decay
              vy *= decay
              if (Math.abs(vx) < 0.002 && Math.abs(vy) < 0.002) {
                snapBack()
                return
              }
              const cur = map.project(map.getCenter())
              const target = map.unproject([cur.x - vx * 16, cur.y - vy * 16])
              if (overshootFromBoundary(target.lng, target.lat) > 0) {
                snapBack()
                return
              }
              map.jumpTo({ center: [target.lng, target.lat] })
              requestAnimationFrame(coast)
            })()
          }
        }

        canvasEl.addEventListener('pointerup', endDrag)
        canvasEl.addEventListener('pointercancel', endDrag)

        // Constrain zoom/keyboard-induced pan
        map.on('moveend', () => {
          if (!dragging && !animating) snapBack()
        })

        const overlay = new MapboxOverlay({ interleaved: false, layers: [] })
        map.addControl(overlay)

        if (import.meta.env.DEV) {
          ;(window as unknown as { __campusMap?: unknown }).__campusMap = map
        }

        map.on('error', (event: { error?: Error }) => {
          // Style/tile failures (e.g. offline) → text fallback; transient tile
          // errors after load are ignored.
          if (!map.isStyleLoaded()) {
            setStatus('error')
          }
          console.warn('Map error', event.error?.message)
        })
        map.on('load', () => {
          if (!disposed) {
            setStatus('ready')
            // Defer basemap tinting to next frame so deck.gl overlay initializes first
            requestAnimationFrame(() => patchBasemapColors(map, initialTheme))
          }
        })

        // WebGL context loss: report error so the parent can offer retry
        const canvas = map.getCanvas()
        canvas.addEventListener('webglcontextlost', () => {
          if (!disposed) setStatus('error')
        })

        // Shader extension: bottom-to-top gradient on building sides
        class GradientExtension extends core.LayerExtension {
          getShaders() {
            return {
              inject: {
                'vs:#decl': 'out float vHeightFrac;',
                'vs:#main-end':
                  'vHeightFrac = clamp(geometry.position.z / 35.0, 0.0, 1.0);',
                'fs:#decl': 'in float vHeightFrac;',
                'fs:DECKGL_FILTER_COLOR': `
                  color.rgb *= mix(0.7, 1.0, vHeightFrac);
                `,
              },
            }
          }
        }

        handlesRef.current = {
          map,
          overlay,
          layerModules: {
            GeoJsonLayer: layers.GeoJsonLayer,
            PathLayer: layers.PathLayer,
            ScatterplotLayer: layers.ScatterplotLayer,
            TextLayer: layers.TextLayer,
          },
          gradientExtension: new GradientExtension(),
        }

        if (controls) {
          const duration = () => (prefersReducedMotion() ? 0 : 300)
          controls.current = {
            zoomIn: () => map.zoomIn({ duration: duration() }),
            zoomOut: () => map.zoomOut({ duration: duration() }),
            resetView: () =>
              map.flyTo({
                ...INITIAL_VIEW,
                duration: prefersReducedMotion() ? 0 : 700,
                essential: true,
              }),
          }
        }
      } catch (error) {
        console.warn('Map init failed', error)
        if (!disposed) setStatus('error')
      }
    })()

    return () => {
      disposed = true
      if (controls?.current) controls.current = null
      const handles = handlesRef.current
      handlesRef.current = null
      if (handles) {
        handles.map.removeControl(handles.overlay)
        handles.map.remove()
      }
    }
    // `controls` is a stable ref from the parent; init runs exactly once per mount.
  }, [controls])

  // ---- Data: buildings (required), walking routes (on demand) ----
  useEffect(() => {
    let cancelled = false
    getBuildingsGeo()
      .then((collection) => {
        if (!cancelled) {
          setBuildings(collection)
          hullRef.current = convexHull(collection)
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!showRoutes || walkingRoutes) return
    let cancelled = false
    getWalkingRoutesGeo()
      .then((collection) => {
        if (!cancelled) setWalkingRoutes(collection)
      })
      .catch(() => {
        // Optional layer — buildings and routes still work without it.
      })
    return () => {
      cancelled = true
    }
  }, [showRoutes, walkingRoutes])

  // ---- Route polyline: compute the pedestrian-network path for a route
  // highlight; falls back to the straight centroid line if it fails. ----
  useEffect(() => {
    if (highlight?.kind !== 'route') {
      setRoutePath(null)
      return
    }
    const key = `${highlight.from}|${highlight.to}`
    let cancelled = false
    Promise.all([resolveBuilding(highlight.from), resolveBuilding(highlight.to)])
      .then(([from, to]) => computeRoute(from, to))
      .then((route) => {
        if (!cancelled && route.polyline.length >= 2)
          setRoutePath({ key, path: route.polyline })
      })
      .catch(() => {
        if (cancelled) return
        const route = resolveRoute(buildings, highlight)
        if (route) setRoutePath({ key, path: [route.fromCenter, route.toCenter] })
      })
    return () => {
      cancelled = true
    }
    // `buildings` is intentionally read fresh only in the fallback; refetching
    // on its arrival is unnecessary — the highlight always changes later.
  }, [highlight, buildings])

  // ---- Draw-on animation for the route trace ----
  useEffect(() => {
    if (!routePath) return
    if (prefersReducedMotion()) {
      setDrawProgress(1)
      return
    }
    setDrawProgress(0)
    let frame = 0
    let start: number | undefined
    let frameCount = 0
    const tick = (now: number) => {
      start ??= now
      const raw = Math.min(1, (now - start) / ROUTE_DRAW_MS)
      const t = 1 - (1 - raw) ** 3 // ease-out cubic
      // Throttle state updates to every 3rd frame to reduce layer rebuilds
      frameCount++
      if (frameCount % 3 === 0 || raw >= 1) {
        setDrawProgress(t)
      }
      if (raw < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [routePath])

  // ---- Layers ----
  useEffect(() => {
    // `status` gates the pass so layers apply once the map reports ready.
    const handles = handlesRef.current
    if (!handles || !buildings || status === 'error') return
    const { GeoJsonLayer, PathLayer, ScatterplotLayer, TextLayer } =
      handles.layerModules
    const colors = MAP_COLORS[theme]
    const route = resolveRoute(buildings, highlight)
    const focusedBuildings = highlight?.kind === 'buildings' ? highlight.buildings : []
    const highlightedCodes = new Set(
      [route?.from, route?.to]
        .map((f) => (f?.properties?.BLDG_CODE ?? '').toString().toUpperCase())
        .filter(Boolean),
    )
    for (const b of focusedBuildings) highlightedCodes.add(b.code.toUpperCase())
    if (selected) highlightedCodes.add(selected.code.toUpperCase())
    // Anchor building of a places search gets the highlight tint too.
    if (highlight?.kind === 'places' && highlight.near)
      highlightedCodes.add(highlight.near.toUpperCase())
    const pins = highlight?.kind === 'places' ? highlight.places : []

    const isHighlighted = (feature: BuildingFeature) =>
      highlightedCodes.has(
        (feature.properties?.BLDG_CODE ?? '').toString().toUpperCase(),
      )

    const endpoints = route
      ? [
          {
            center: route.fromCenter,
            feature: route.from,
            text: highlight?.kind === 'route' ? highlight.from : '',
          },
          {
            center: route.toCenter,
            feature: route.to,
            text: highlight?.kind === 'route' ? highlight.to : '',
          },
        ]
      : []

    const layers = [
      showRoutes && walkingRoutes
        ? new GeoJsonLayer({
            id: 'walking-routes',
            data: walkingRoutes,
            stroked: true,
            filled: false,
            getLineColor: colors.walkway,
            getLineWidth: 2,
            lineWidthUnits: 'pixels' as const,
            lineCapRounded: true,
            lineJointRounded: true,
          })
        : null,
      new GeoJsonLayer({
        id: 'buildings',
        data: buildings,
        extruded: true,
        wireframe: false,
        extensions: [handles.gradientExtension],
        getElevation: (feature) => buildingHeight(feature as BuildingFeature),
        getFillColor: (feature) =>
          isHighlighted(feature as BuildingFeature)
            ? colors.fillHighlight
            : colors.fill,
        getLineColor: (feature) =>
          isHighlighted(feature as BuildingFeature)
            ? colors.lineHighlight
            : colors.line,
        material: { ambient: 1, diffuse: 0.6, shininess: 1 },
        stroked: true,
        getLineWidth: 1,
        lineWidthUnits: 'pixels' as const,
        pickable: true,
        autoHighlight: true,
        highlightColor: [124, 158, 178, 120],
        transitions: { getFillColor: 300 },
        // Hover for pointers, click/tap for touch: selecting a building
        // shows its name and code.
        onHover: (info) => {
          const properties = (info.object as BuildingFeature | undefined)
            ?.properties
          if (properties?.NAME || properties?.BLDG_CODE) {
            setPicked({
              name: String(properties.NAME ?? ''),
              code: String(properties.BLDG_CODE ?? ''),
              x: info.x,
              y: info.y,
            })
          } else {
            setPicked(null)
          }
        },
        // Click/tap opens the details popup (rooms, study rooms, services).
        onClick: (info) => {
          if (didPanRef.current) return // suppress click after drag
          const properties = (info.object as BuildingFeature | undefined)
            ?.properties
          if (!properties?.BLDG_CODE) {
            setSelected(null)
            return
          }
          setPicked(null)
          setSelected({
            code: String(properties.BLDG_CODE),
            name: String(properties.NAME ?? properties.BLDG_CODE),
            usage:
              properties.BLDG_USAGE != null ? String(properties.BLDG_USAGE) : null,
            floors:
              properties.MAX_FLOORS != null ? String(properties.MAX_FLOORS) : null,
            address:
              properties.PRIMARY_ADDRESS != null
                ? String(properties.PRIMARY_ADDRESS)
                : null,
          })
        },
        updateTriggers: {
          getFillColor: [theme, ...highlightedCodes],
          getLineColor: [theme, ...highlightedCodes],
        },
      }),
      routePath
        ? new PathLayer({
            id: 'route-trace',
            data: [{ path: partialPath(routePath.path, drawProgress) }],
            getPath: (d: { path: LngLat[] }) => d.path,
            getColor: colors.route,
            getWidth: 5,
            widthUnits: 'pixels' as const,
            capRounded: true,
            jointRounded: true,
            updateTriggers: { getPath: [routePath.key, drawProgress] },
          })
        : null,
      endpoints.length > 0
        ? new ScatterplotLayer({
            id: 'route-endpoints',
            // Dots mark where the walk starts/ends — the entrances the polyline
            // connects, not the building centroids.
            data: (routePath
              ? [routePath.path[0], routePath.path[routePath.path.length - 1]].map(
                  (p) => ({ position: [...p, 2] }),
                )
              : endpoints.map((e) => ({
                  position: [...e.center, buildingHeight(e.feature) + 4],
                }))) as { position: [number, number, number] }[],
            getPosition: (d: { position: [number, number, number] }) => d.position,
            getRadius: 5,
            radiusUnits: 'pixels' as const,
            getFillColor: colors.route,
            stroked: true,
            getLineColor: colors.routeCasing,
            getLineWidth: 3,
            lineWidthUnits: 'pixels' as const,
          })
        : null,
      endpoints.length > 0
        ? new TextLayer({
            id: 'route-labels',
            data: endpoints.map((e) => ({
              position: [...e.center, buildingHeight(e.feature) + 10],
              text: e.text,
            })),
            getPosition: (d: { position: [number, number, number] }) => d.position,
            getText: (d: { text: string }) => d.text,
            getSize: 13,
            getColor: colors.label,
            background: true,
            getBackgroundColor: colors.labelBg,
            backgroundPadding: [6, 3],
            fontFamily: LABEL_FONT,
            fontWeight: 600,
            getPixelOffset: [0, -14],
          })
        : null,
      pins.length > 0
        ? new ScatterplotLayer({
            id: 'place-pins',
            data: pins.map((p) => ({
              position: [p.lon, p.lat, 2] as [number, number, number],
            })),
            getPosition: (d: { position: [number, number, number] }) => d.position,
            getRadius: 6,
            radiusUnits: 'pixels' as const,
            getFillColor: colors.route,
            stroked: true,
            getLineColor: colors.routeCasing,
            getLineWidth: 2,
            lineWidthUnits: 'pixels' as const,
          })
        : null,
      pins.length > 0
        ? new TextLayer({
            id: 'place-labels',
            data: pins.map((p) => ({
              position: [p.lon, p.lat, 2] as [number, number, number],
              text: p.name,
            })),
            getPosition: (d: { position: [number, number, number] }) => d.position,
            getText: (d: { text: string }) => d.text,
            getSize: 12,
            getColor: colors.label,
            background: true,
            getBackgroundColor: colors.labelBg,
            backgroundPadding: [5, 2],
            fontFamily: LABEL_FONT,
            fontWeight: 600,
            getPixelOffset: [0, -16],
          })
        : null,
      focusedBuildings.length > 0
        ? new TextLayer({
            id: 'building-labels',
            data: focusedBuildings.map((b) => {
              const feature = findBuilding(buildings, b.code)
              const center = (feature && featureCentroid(feature)) ?? [b.lon, b.lat]
              return {
                position: [
                  ...center,
                  feature ? buildingHeight(feature) + 10 : 10,
                ] as [number, number, number],
                text: b.name,
              }
            }),
            getPosition: (d: { position: [number, number, number] }) => d.position,
            getText: (d: { text: string }) => d.text,
            getSize: 13,
            getColor: colors.label,
            background: true,
            getBackgroundColor: colors.labelBg,
            backgroundPadding: [6, 3],
            fontFamily: LABEL_FONT,
            fontWeight: 600,
            getPixelOffset: [0, -14],
          })
        : null,
    ].filter(Boolean)

    try {
      handles.overlay.setProps({ layers })
    } catch (e) {
      console.warn('deck.gl layer error:', e)
      setStatus('error')
    }
  }, [
    buildings,
    walkingRoutes,
    showRoutes,
    highlight,
    theme,
    status,
    routePath,
    drawProgress,
    selected,
  ])

  // ---- Theme: swap basemap style ----
  useEffect(() => {
    const handles = handlesRef.current
    if (!handles || status !== 'ready') return
    let timer: ReturnType<typeof setTimeout> | null = null
    if (appliedStyleRef.current !== theme) {
      appliedStyleRef.current = theme
      const el = containerRef.current
      const fade = !prefersReducedMotion() && el
      if (fade) {
        el.style.transition = 'opacity 200ms ease-out'
        el.style.opacity = '0'
      }
      const apply = () => {
        handles.map.setStyle(STYLE_URLS[theme])
        handles.map.once('style.load', () => {
          requestAnimationFrame(() => patchBasemapColors(handles.map, theme))
          if (fade) {
            el.style.opacity = '1'
          }
        })
      }
      if (fade) timer = setTimeout(apply, 200)
      else apply()
    }
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [theme, status])

  // ---- Camera: focus the highlight (re-runs on "Show on map" bumps) ----
  useEffect(() => {
    void focusNonce
    const handles = handlesRef.current
    if (!handles || status !== 'ready' || !highlight) return
    const duration = prefersReducedMotion() ? 0 : 2000

    if (highlight.kind === 'buildings') {
      if (highlight.buildings.length === 1) {
        const b = highlight.buildings[0]
        handles.map.flyTo({
          center: [b.lon, b.lat],
          zoom: 16.8,
          pitch: 55,
          duration,
          essential: true,
        })
      } else if (highlight.buildings.length > 1) {
        const lons = highlight.buildings.map((b) => b.lon)
        const lats = highlight.buildings.map((b) => b.lat)
        handles.map.fitBounds(
          [
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)],
          ],
          { padding: 90, duration: prefersReducedMotion() ? 0 : 700, maxZoom: 16.6 },
        )
      }
      return
    }

    if (highlight.kind === 'places') {
      const anchor =
        highlight.near && buildings ? findBuilding(buildings, highlight.near) : null
      const anchorCenter = anchor ? featureCentroid(anchor) : null
      const points = [
        ...highlight.places.map((p): LngLat => [p.lon, p.lat]),
        ...(anchorCenter ? [anchorCenter] : []),
      ]
      if (points.length === 0) return
      const lons = points.map((p) => p[0])
      const lats = points.map((p) => p[1])
      handles.map.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding: 90, duration: prefersReducedMotion() ? 0 : 700, maxZoom: 16.6 },
      )
      return
    }

    const route = resolveRoute(buildings, highlight)
    if (!route) return
    const bounds = featuresBounds([route.from, route.to])
    if (!bounds) return
    // Widen to cover the traced polyline, which can detour outside the
    // footprints' box.
    for (const [x, y] of routePath?.path ?? []) {
      if (x < bounds.west) bounds.west = x
      if (x > bounds.east) bounds.east = x
      if (y < bounds.south) bounds.south = y
      if (y > bounds.north) bounds.north = y
    }
    handles.map.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: 90, duration: prefersReducedMotion() ? 0 : 700, maxZoom: 16.6 },
    )
  }, [buildings, highlight, focusNonce, status, routePath])

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-lg"
      onMouseLeave={() => setPicked(null)}
    >
      <div
        ref={containerRef}
        className="h-full w-full"
        role="application"
        aria-label="Interactive campus map"
        aria-roledescription="map"
      />
      {selected && (
        <BuildingPopup
          key={selected.code}
          building={selected}
          onClose={() => setSelected(null)}
        />
      )}
      {picked && (picked.name || picked.code) && (
        <div
          className="pointer-events-none absolute z-10 max-w-60 rounded-lg bg-surface border border-line-soft px-3 py-2 shadow-md"
          style={tooltipPosition(picked, containerRef.current)}
          role="status"
        >
          {picked.name && (
            <p className="text-sm leading-snug font-medium text-fg">
              {picked.name}
            </p>
          )}
          {picked.code && (
            <p className="mt-0.5 font-mono text-xs text-fg-muted">{picked.code}</p>
          )}
        </div>
      )}
      {highlight && (
        <p className="sr-only" role="status">
          {highlight.kind === 'route'
            ? `Route displayed on map: ${highlight.from} to ${highlight.to}, ${formatMeters(highlight.meters)}, ${formatMinutes(highlight.minutes)} walk.`
            : highlight.kind === 'buildings'
              ? `Highlighted on map: ${highlight.buildings.map((b) => `${b.name} (${b.code})`).join(', ')}.`
              : `${highlight.places.length} places marked on map${highlight.near ? ` near ${highlight.near}` : ''}.`}
        </p>
      )}
    </div>
  )
}
