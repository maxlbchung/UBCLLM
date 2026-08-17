// Campus Map tool page — hosts the ported Reogent campus map with hand-driven
// controls replacing the agent's map tools:
//   · Building search  → find_building   (highlight the footprint + fly to it)
//   · Walking route    → walking_distance (Dijkstra over the pedestrian network)
//   · Places search    → find_places      (POI pins, optionally sorted by walk
//                                          distance from a building)
// The map surface keeps the Reogent behaviors: route info card, walking-path
// overlay toggle, reset view, zoom stack, 15 s load timeout with retry, and a
// text fallback when the map can't load. Clicking a building opens the details
// popup (rooms / study-room availability / food & services).
import { useEffect, useRef, useState } from 'react'
import { resolveBuilding, searchBuildings } from '../../lib/map/buildings'
import { formatMeters, formatMinutes } from '../../lib/map/format'
import { findPlaces, listServiceTypes, type PoiWithWalk } from '../../lib/map/places'
import { route as computeRoute } from '../../lib/map/routing'
import type { BuildingDoc, MapHighlight } from '../../lib/map/types'
import { playSfx } from '../../lib/sfx'
import {
  CrosshairIcon,
  ExternalLinkIcon,
  LayersIcon,
  MapIcon,
  MinusIcon,
  PinIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  WalkIcon,
  XIcon,
} from '../icons'
import { CampusMap, type MapControls, type MapStatus } from './CampusMap'

type Mode = 'building' | 'route' | 'places'

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'building', label: 'Buildings' },
  { mode: 'route', label: 'Walking route' },
  { mode: 'places', label: 'Places' },
]

/** Primary label for a map highlight (title line). */
function highlightTitle(h: MapHighlight): string {
  if (h.kind === 'route') return formatMinutes(h.minutes)
  if (h.kind === 'buildings') {
    return h.buildings.length === 1
      ? h.buildings[0].name
      : `${h.buildings.length} buildings`
  }
  return `${h.places.length} place${h.places.length === 1 ? '' : 's'}${h.near ? ` near ${h.near}` : ''}`
}

/** Secondary label for a map highlight (detail line). */
function highlightSubtitle(h: MapHighlight): string {
  if (h.kind === 'route')
    return `${formatMeters(h.meters)} · ${h.from} → ${h.to}`
  if (h.kind === 'buildings') return h.buildings.map((b) => b.code).join(' · ')
  return h.near ? `near ${h.near}` : (h.places[0]?.name ?? '')
}

/** Text-only fallback description when the map fails to load. */
function highlightFallback(h: MapHighlight): string {
  if (h.kind === 'route') {
    return `${formatMeters(h.meters)}, about ${formatMinutes(h.minutes)} walking from ${h.from} to ${h.to}.`
  }
  if (h.kind === 'buildings')
    return h.buildings.map((b) => `${b.name} (${b.code})`).join(', ')
  return (
    h.places.map((p) => p.name).join(', ') + (h.near ? ` — near ${h.near}` : '')
  )
}

const inputClass =
  'w-full rounded bg-input border border-line-soft px-2.5 py-1.5 text-sm text-fg ' +
  'placeholder:text-fg-faint focus:outline-none focus:border-accent-hover'

/** Building text input with ranked suggestions from the building index. */
function BuildingInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  label: string
}) {
  const [suggestions, setSuggestions] = useState<BuildingDoc[]>([])
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || value.trim().length < 2) return
    let cancelled = false
    searchBuildings(value, 6)
      .then((docs) => {
        if (!cancelled) setSuggestions(docs)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [value, open])

  return (
    <div ref={wrapRef} className="relative">
      <label className="mb-1 block text-xs text-fg-muted">{label}</label>
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          // Clear stale suggestions in the handler (not the fetch effect) when
          // the query drops below the fetch threshold.
          if (e.target.value.trim().length < 2) setSuggestions([])
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Delay so a suggestion click lands before the list unmounts.
          setTimeout(() => setOpen(false), 150)
        }}
        onKeyDown={(e) => {
          // Enter submits the surrounding form; either way the list should
          // get out of the way (it floats over the submit button).
          if (e.key === 'Escape' || e.key === 'Enter') setOpen(false)
        }}
        placeholder={placeholder}
        className={inputClass}
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full overflow-hidden rounded border border-line-soft bg-surface shadow-lg shadow-black/30">
          {suggestions.map((s) => (
            <li key={s.code}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(s.code)
                  setOpen(false)
                }}
                className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-sm text-fg hover:bg-surface-raised"
              >
                <span className="font-mono text-xs text-accent">{s.code}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                  {s.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function CampusMapPage() {
  const [mode, setMode] = useState<Mode>('building')
  const [highlight, setHighlight] = useState<MapHighlight | null>(null)
  const [focusNonce, setFocusNonce] = useState(0)
  const [showRoutes, setShowRoutes] = useState(false)
  const [status, setStatus] = useState<MapStatus>('loading')
  const [mapKey, setMapKey] = useState(0)
  const controls = useRef<MapControls | null>(null)

  // Form state
  const [buildingQuery, setBuildingQuery] = useState('')
  const [fromQuery, setFromQuery] = useState('')
  const [toQuery, setToQuery] = useState('')
  const [placeQuery, setPlaceQuery] = useState('')
  const [serviceType, setServiceType] = useState('')
  const [nearQuery, setNearQuery] = useState('')
  const [serviceTypes, setServiceTypes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Note under a route result (straight-line estimate vs network path). */
  const [routeMethod, setRouteMethod] = useState<'network' | 'estimate' | null>(
    null,
  )
  const [placeResults, setPlaceResults] = useState<PoiWithWalk[] | null>(null)

  // Timeout: if map stays loading for 15s, treat as error
  useEffect(() => {
    if (status !== 'loading') return
    const timer = setTimeout(() => setStatus('error'), 15_000)
    return () => clearTimeout(timer)
  }, [status])

  useEffect(() => {
    listServiceTypes()
      .then(setServiceTypes)
      .catch(() => {})
  }, [])

  function retryMap() {
    setStatus('loading')
    setMapKey((k) => k + 1)
  }

  function switchMode(m: Mode) {
    if (m !== mode) playSfx('tab')
    setMode(m)
    setError(null)
  }

  function apply(h: MapHighlight) {
    setHighlight(h)
    setFocusNonce((n) => n + 1)
  }

  async function submitBuilding() {
    if (!buildingQuery.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const b = await resolveBuilding(buildingQuery)
      apply({
        kind: 'buildings',
        buildings: [{ code: b.code, name: b.name, lat: b.lat, lon: b.lon }],
      })
      playSfx('success')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Building lookup failed')
    } finally {
      setBusy(false)
    }
  }

  async function submitRoute() {
    if (!fromQuery.trim() || !toQuery.trim() || busy) return
    setBusy(true)
    setError(null)
    setRouteMethod(null)
    try {
      const [from, to] = await Promise.all([
        resolveBuilding(fromQuery),
        resolveBuilding(toQuery),
      ])
      if (from.code === to.code) {
        apply({ kind: 'route', from: from.code, to: to.code, meters: 0, minutes: 0 })
        setRouteMethod('network')
      } else {
        const r = await computeRoute(from, to)
        apply({
          kind: 'route',
          from: from.code,
          to: to.code,
          meters: r.meters,
          minutes: r.minutes,
        })
        setRouteMethod(r.method)
      }
      playSfx('success')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Route lookup failed')
    } finally {
      setBusy(false)
    }
  }

  async function submitPlaces() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { near, places } = await findPlaces({
        query: placeQuery,
        serviceType: serviceType || undefined,
        nearBuilding: nearQuery || undefined,
        limit: 10,
      })
      if (places.length === 0) {
        setPlaceResults([])
        throw new Error(
          `No places matched "${placeQuery || serviceType || nearQuery}"`,
        )
      }
      setPlaceResults(places)
      apply({
        kind: 'places',
        near: near?.code ?? null,
        places: places.map((p) => ({
          name: p.name,
          lat: p.lat,
          lon: p.lon,
          service_type: p.service_type,
        })),
      })
      playSfx('success')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Places search failed')
    } finally {
      setBusy(false)
    }
  }

  const submitClass =
    'flex h-8 items-center justify-center gap-1.5 rounded bg-accent px-3 text-sm ' +
    'font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50'

  return (
    <div className="flex h-full min-h-0 flex-col p-4 gap-3">
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        {/* ---- Controls panel ---- */}
        <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto lg:w-80">
          <div className="flex items-center gap-2">
            <MapIcon className="w-4 h-4 text-accent" />
            <h2 className="text-sm font-semibold text-fg">Campus Map</h2>
            <span className="text-xs text-fg-faint">UBC Vancouver</span>
          </div>

          <div className="flex rounded border border-line-soft p-0.5">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                onClick={() => switchMode(m.mode)}
                className={
                  'flex-1 rounded px-2 py-1 text-xs font-medium ' +
                  (mode === m.mode
                    ? 'bg-surface-raised text-fg'
                    : 'text-fg-muted hover:text-fg')
                }
                aria-pressed={mode === m.mode}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'building' && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void submitBuilding()
              }}
            >
              <BuildingInput
                label="Building name or code"
                value={buildingQuery}
                onChange={setBuildingQuery}
                placeholder='e.g. "ICCS" or "Irving K. Barber"'
              />
              <button type="submit" disabled={busy} className={submitClass}>
                <SearchIcon className="w-3.5 h-3.5" />
                Find building
              </button>
              <p className="text-xs text-fg-faint leading-relaxed">
                Codes, colloquial acronyms ("IKB"), and partial names all work.
                Click any footprint on the map for rooms, study-room
                availability, and services inside.
              </p>
            </form>
          )}

          {mode === 'route' && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void submitRoute()
              }}
            >
              <BuildingInput
                label="From"
                value={fromQuery}
                onChange={setFromQuery}
                placeholder='e.g. "ICCS"'
              />
              <BuildingInput
                label="To"
                value={toQuery}
                onChange={setToQuery}
                placeholder='e.g. "BUCH"'
              />
              <button type="submit" disabled={busy} className={submitClass}>
                <WalkIcon className="w-3.5 h-3.5" />
                Route it
              </button>
              {highlight?.kind === 'route' && !error && (
                <div className="rounded border border-line bg-surface px-2.5 py-2 text-sm text-fg">
                  <span className="font-medium">
                    {formatMinutes(highlight.minutes)}
                  </span>{' '}
                  <span className="text-fg-muted">
                    · {formatMeters(highlight.meters)} · {highlight.from} →{' '}
                    {highlight.to}
                  </span>
                  {routeMethod === 'estimate' && (
                    <p className="mt-1 text-xs text-fg-faint">
                      Straight-line estimate — the path network doesn't reach
                      one of these buildings.
                    </p>
                  )}
                </div>
              )}
              <p className="text-xs text-fg-faint leading-relaxed">
                Door-to-door over the campus pedestrian network (about 80 m/min
                walking speed). The traced path draws on the map.
              </p>
            </form>
          )}

          {mode === 'places' && (
            <form
              className="flex min-h-0 flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void submitPlaces()
              }}
            >
              <div>
                <label className="mb-1 block text-xs text-fg-muted">
                  Name keywords (optional)
                </label>
                <input
                  value={placeQuery}
                  onChange={(e) => setPlaceQuery(e.target.value)}
                  placeholder='e.g. "Tim Hortons"'
                  className={inputClass}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-fg-muted">Type</label>
                <select
                  value={serviceType}
                  onChange={(e) => setServiceType(e.target.value)}
                  className={inputClass}
                >
                  <option value="">Any type</option>
                  {serviceTypes.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>
              <BuildingInput
                label="Near building (optional — sorts by walk)"
                value={nearQuery}
                onChange={setNearQuery}
                placeholder='e.g. "IKB"'
              />
              <button type="submit" disabled={busy} className={submitClass}>
                <PinIcon className="w-3.5 h-3.5" />
                Find places
              </button>
              {placeResults && placeResults.length > 0 && (
                <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
                  {placeResults.map((p) => (
                    <li
                      key={p.id}
                      className="rounded border border-line bg-surface px-2.5 py-1.5"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-medium text-fg">
                          {p.url ? (
                            <a
                              href={p.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline"
                            >
                              {p.name}
                              <ExternalLinkIcon className="ml-1 inline w-3 h-3 text-fg-faint" />
                            </a>
                          ) : (
                            p.name
                          )}
                        </span>
                        {p.walk_minutes != null && (
                          <span className="shrink-0 text-xs text-fg-muted">
                            {formatMinutes(p.walk_minutes)} ·{' '}
                            {formatMeters(p.walk_meters ?? 0)}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-fg-faint">
                        {[p.service_type?.replace(/_/g, ' '), p.hours]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </form>
          )}

          {error && (
            <p className="rounded border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-xs text-danger-soft-fg">
              {error}
            </p>
          )}
        </aside>

        {/* ---- Map surface ---- */}
        <div
          className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-line"
          aria-busy={status === 'loading'}
        >
          {status === 'error' ? (
            <div
              role="status"
              className="flex h-full flex-col items-center justify-center gap-2 bg-surface px-6 text-center"
            >
              <MapIcon className="w-8 h-8 text-fg-faint" />
              <p className="text-sm text-fg-muted">
                Map couldn't load. Details are shown below.
              </p>
              <button
                type="button"
                onClick={retryMap}
                className="mt-2 flex h-9 items-center gap-1.5 rounded bg-surface-raised px-3 text-sm font-medium text-fg hover:bg-line-soft"
              >
                <RefreshIcon className="w-3.5 h-3.5" />
                Retry
              </button>
              {highlight && (
                <p className="max-w-60 text-sm text-fg">
                  {highlightFallback(highlight)}
                </p>
              )}
            </div>
          ) : (
            <>
              <CampusMap
                key={mapKey}
                highlight={highlight}
                focusNonce={focusNonce}
                showRoutes={showRoutes}
                onStatus={setStatus}
                controls={controls}
              />
              {status === 'loading' && (
                <div
                  className="absolute inset-0 animate-pulse bg-surface"
                  aria-hidden="true"
                />
              )}

              {/* Highlight info — floating top-right (clear of the popup on the left) */}
              {highlight && (
                <div className="absolute top-3 right-14 z-10 max-w-[70%]">
                  <div className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-surface/95 px-3 py-2 shadow-md">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-fg">
                      {highlight.kind === 'route' ? (
                        <WalkIcon className="w-4.5 h-4.5" />
                      ) : (
                        <PinIcon className="w-4.5 h-4.5" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm leading-tight font-medium text-fg">
                        {highlightTitle(highlight)}
                      </span>
                      <span className="block truncate text-xs text-fg-muted">
                        {highlightSubtitle(highlight)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        playSfx('click')
                        setHighlight(null)
                        setPlaceResults(null)
                        setRouteMethod(null)
                      }}
                      aria-label="Clear highlight"
                      className="shrink-0 rounded p-1 text-fg-faint hover:bg-surface-raised hover:text-fg"
                    >
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* Layer + view controls — floating top-right */}
              <div className="absolute top-3 right-3 z-10 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    playSfx('click')
                    setShowRoutes((v) => !v)
                  }}
                  aria-label={
                    showRoutes ? 'Hide walking paths' : 'Show walking paths'
                  }
                  title={showRoutes ? 'Hide walking paths' : 'Show walking paths'}
                  aria-pressed={showRoutes}
                  className={
                    'flex size-9 items-center justify-center rounded-lg border border-line-soft bg-surface shadow-md ' +
                    (showRoutes ? 'text-accent' : 'text-fg-muted hover:text-accent')
                  }
                >
                  <LayersIcon className="w-4.5 h-4.5" />
                </button>
                <button
                  type="button"
                  onClick={() => controls.current?.resetView()}
                  aria-label="Reset view"
                  title="Reset view"
                  className="flex size-9 items-center justify-center rounded-lg border border-line-soft bg-surface text-fg-muted shadow-md hover:text-accent"
                >
                  <CrosshairIcon className="w-4.5 h-4.5" />
                </button>
              </div>

              {/* Zoom — floating bottom-right */}
              <div className="absolute right-3 bottom-6 z-10 flex flex-col overflow-hidden rounded-lg border border-line-soft bg-surface shadow-md">
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() => controls.current?.zoomIn()}
                  className="flex size-9 items-center justify-center text-fg-muted hover:text-accent"
                >
                  <PlusIcon className="w-4.5 h-4.5" />
                </button>
                <span className="mx-2 block h-px bg-line" aria-hidden="true" />
                <button
                  type="button"
                  aria-label="Zoom out"
                  onClick={() => controls.current?.zoomOut()}
                  className="flex size-9 items-center justify-center text-fg-muted hover:text-accent"
                >
                  <MinusIcon className="w-4.5 h-4.5" />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
