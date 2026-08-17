// Building popup for the campus map: click a footprint → header card with the
// building's vitals plus swipeable carousels of rooms (Find a Space), bookable
// study rooms (LibCal availability snapshot), and food & services (POIs).
// Ported from Reogent's building-popup, restyled to this app's tokens.
//
// Card images: Reogent refreshes stale thumbnails through a server-side
// og:image proxy (/api/preview) — this app is fully static, so cards use the
// stored photo/thumbnail directly. The image slot is always reserved: a
// placeholder shows until load and stays on failure, so a stale signed URL
// degrades to the placeholder instead of breaking the card.
import { useEffect, useRef, useState } from 'react'
import { getBuildingDetails } from '../../lib/map/details'
import type { BuildingDetails } from '../../lib/map/types'
import {
  BuildingIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  RefreshIcon,
  XIcon,
} from '../icons'

export interface SelectedBuilding {
  code: string
  name: string
  usage: string | null
  floors: string | null
  address: string | null
}

function Carousel({
  label,
  children,
}: {
  label: string
  children: React.ReactNode[]
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const scrollBy = (dir: -1 | 1) =>
    scroller.current?.scrollBy({
      left: dir * scroller.current.clientWidth,
      behavior: 'smooth',
    })
  return (
    <section
      className="flex items-center gap-1"
      aria-roledescription="carousel"
      aria-label={label}
    >
      <button
        type="button"
        aria-label={`Previous ${label}`}
        onClick={() => scrollBy(-1)}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-raised text-fg-muted hover:text-fg"
      >
        <ChevronLeftIcon className="w-3.5 h-3.5" />
      </button>
      <div
        ref={scroller}
        className="flex min-w-0 flex-1 snap-x snap-mandatory [scrollbar-width:none] gap-2 overflow-x-auto [overscroll-behavior-x:contain] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      <button
        type="button"
        aria-label={`Next ${label}`}
        onClick={() => scrollBy(1)}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-raised text-fg-muted hover:text-fg"
      >
        <ChevronRightIcon className="w-3.5 h-3.5" />
      </button>
    </section>
  )
}

function DetailCard({
  src,
  href,
  title,
  sub,
  meta,
  dot,
}: {
  /** Image URL — the stored photo/thumbnail (may be a stale signed URL). */
  src?: string | null
  href?: string | null
  title: string
  sub?: string | null
  meta?: string | null
  dot?: 'free' | 'busy'
}) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const body = (
    <>
      <div className="relative h-32 shrink-0 overflow-hidden bg-surface-raised">
        <span
          className="absolute inset-0 flex items-center justify-center text-fg-faint"
          aria-hidden="true"
        >
          <BuildingIcon className="w-8 h-8 opacity-40" />
        </span>
        {src && !failed && (
          <img
            src={src}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={`relative h-full w-full bg-surface object-contain transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
          />
        )}
      </div>
      <div className="flex flex-col gap-0.5 px-2.5 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
          {dot && (
            // The sub line states the availability in words; the dot is decoration.
            <span
              className={`size-2 shrink-0 rounded-full ${dot === 'free' ? 'bg-accent' : 'bg-danger'}`}
              aria-hidden="true"
            />
          )}
          <span className="truncate">{title}</span>
        </span>
        {sub && <span className="text-xs text-fg-muted">{sub}</span>}
        {meta && <span className="truncate text-xs text-fg-faint">{meta}</span>}
      </div>
    </>
  )
  const cardClass =
    'flex w-full shrink-0 snap-start snap-always flex-col overflow-hidden rounded-lg bg-surface border border-line'
  return href ? (
    <a className={cardClass} href={href} target="_blank" rel="noreferrer">
      {body}
    </a>
  ) : (
    <div className={cardClass}>{body}</div>
  )
}

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string | null
  children: React.ReactNode
}) {
  return (
    <section className="border-t border-line pt-2.5">
      <h3 className="mb-2 text-sm font-medium text-fg">
        {title}
        {note && (
          <span className="ml-1.5 text-xs font-normal text-fg-faint">{note}</span>
        )}
      </h3>
      {children}
    </section>
  )
}

export function BuildingPopup({
  building,
  onClose,
}: {
  building: SelectedBuilding
  onClose: () => void
}) {
  const [details, setDetails] = useState<BuildingDetails | null>(null)
  const [failed, setFailed] = useState(false)
  const [fetchNonce, setFetchNonce] = useState(0)
  const popupRef = useRef<HTMLElement>(null)

  // The parent keys this component by building code, so a different building
  // remounts with fresh state; the retry button resets state in its handler.
  useEffect(() => {
    void fetchNonce
    let cancelled = false
    getBuildingDetails(building.code)
      .then((d) => {
        if (!cancelled) setDetails(d)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [building.code, fetchNonce])

  // Escape to close (focus starts on the close button)
  useEffect(() => {
    const el = popupRef.current
    if (!el) return
    const closeBtn = el.querySelector<HTMLElement>(
      '[aria-label="Close building details"]',
    )
    closeBtn?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const availability = details?.availability
  return (
    <aside
      ref={popupRef}
      role="dialog"
      aria-modal="false"
      aria-label={`${building.name} details`}
      className="absolute top-3 bottom-6 left-3 z-20 flex w-80 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border border-line-soft bg-canvas shadow-lg shadow-black/30"
    >
      <div className="flex items-start gap-2.5 border-b border-line px-3.5 py-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-fg">
          <BuildingIcon className="w-4.5 h-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base leading-snug font-medium text-fg">
            {building.name}
          </h2>
          <p className="mt-0.5 truncate font-mono text-xs text-fg-muted">
            {[building.code, building.usage].filter(Boolean).join(' · ')}
          </p>
          {(building.floors || building.address) && (
            <p className="mt-0.5 truncate text-xs text-fg-faint">
              {[building.floors && `${building.floors} floors`, building.address]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close building details"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          <XIcon className="w-4 h-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto [overscroll-behavior-y:contain] px-3.5 py-3">
        {!details && !failed && (
          <div
            className="flex flex-col gap-2"
            role="status"
            aria-label="Loading details"
          >
            <div className="h-32 animate-pulse rounded-lg bg-surface-raised" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-surface-raised" />
          </div>
        )}
        {failed && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-fg-muted">
              Couldn't load details for this building.
            </p>
            <button
              type="button"
              onClick={() => {
                setDetails(null)
                setFailed(false)
                setFetchNonce((n) => n + 1)
              }}
              className="flex h-9 items-center gap-1.5 rounded bg-surface-raised px-3 text-sm font-medium text-fg hover:bg-line-soft"
            >
              <RefreshIcon className="w-3.5 h-3.5" />
              Retry
            </button>
          </div>
        )}
        {details && (
          <>
            {details.rooms.length > 0 && (
              <Section title={`Rooms (${details.rooms.length})`}>
                <Carousel label="rooms">
                  {details.rooms.map((room) => (
                    <DetailCard
                      key={room.name}
                      src={room.photo}
                      href={room.link}
                      title={room.name}
                      sub={`${room.capacity ?? '?'} seats · floor ${room.floor ?? '?'}`}
                      meta={[room.layout, room.furniture]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                  ))}
                </Carousel>
              </Section>
            )}
            {availability && availability.rooms.length > 0 && (
              <Section
                title="Study rooms"
                note={
                  availability.as_of
                    ? `as of ${availability.as_of.slice(0, 10)}`
                    : null
                }
              >
                <Carousel label="study rooms">
                  {availability.rooms.map((room) => (
                    <DetailCard
                      key={room.title}
                      src={room.thumbnail}
                      href={room.url}
                      title={room.title}
                      dot={room.freeNow ? 'free' : 'busy'}
                      sub={
                        room.freeNow
                          ? `free until ${room.freeUntil ?? 'end of day'}`
                          : room.nextFree
                            ? `free at ${room.nextFree}`
                            : 'booked today'
                      }
                      meta={`${room.capacity ?? '?'} people · book on LibCal`}
                    />
                  ))}
                </Carousel>
              </Section>
            )}
            {details.pois.length > 0 && (
              <Section title={`Food & services (${details.pois.length})`}>
                <Carousel label="services">
                  {details.pois.map((poi) => (
                    <DetailCard
                      key={poi.name}
                      src={poi.photo}
                      href={poi.url}
                      title={poi.name}
                      sub={poi.service_type?.replace(/_/g, ' ')}
                      meta={poi.hours || poi.contact}
                    />
                  ))}
                </Carousel>
              </Section>
            )}
            {details.rooms.length === 0 &&
              !availability?.rooms.length &&
              details.pois.length === 0 && (
                <p className="text-sm text-fg-muted">
                  No room or service listings for this building.
                </p>
              )}
          </>
        )}
      </div>
    </aside>
  )
}
