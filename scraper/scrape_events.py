"""Scrape https://events.ubc.ca/ for upcoming UBC events.

The site runs The Events Calendar (Tribe) WordPress plugin, which exposes
a JSON REST API at ``/wp-json/tribe/events/v1/events``. We pull paginated
JSON pages of upcoming events directly — much more reliable than scraping
the HTML cards, and the schema gives us venue and an "all day" flag for
free.

This host is *outside* ``common.BASE_URL`` (which only covers
vancouver.calendar.ubc.ca). ``RateLimitedClient`` is host-agnostic so we
reuse it as-is for throttling and on-disk caching.

We only emit events whose ``categories`` list mentions Vancouver (or that
have no campus signal at all). Okanagan-only events are dropped because
this app targets UBC Vancouver. The cache is keyed on the full API URL
including query parameters, so re-running with a different
``--start-date`` doesn't smash the existing cache file.

Output: scraper/output/events.json

Usage:
    uv run scrape_events.py
    uv run scrape_events.py --refresh
    uv run scrape_events.py --max-pages 4
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import html
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from common import (
    OUTPUT_DIR,
    RateLimitedClient,
    configure_logging,
    log,
    make_async_client,
)

API_BASE = "https://events.ubc.ca/wp-json/tribe/events/v1/events"
OUTPUT_FILE = OUTPUT_DIR / "events.json"

# Tribe returns "YYYY-MM-DD HH:MM:SS" in the venue's local timezone. We
# strip the time portion for `date` and `endDate`; the calendar widget
# only displays date granularity.
_DATETIME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?")


@dataclass
class Event:
    url: str
    title: str
    start: str  # 'YYYY-MM-DD' or ISO datetime if all-day-ish ambiguity
    end: str | None = None
    image: str | None = None
    location: str | None = None
    all_day: bool = False


# How far apart two same-titled events can be before they're treated as
# separate occurrences. The events API publishes each day of a multi-day
# fair / orientation as its own record with a slug-numbered URL; we fold
# those into the earliest day. Weekly drop-ins (≥7 days apart) still
# show each week because they exceed this gap.
_CLUSTER_GAP_DAYS = 2


def _collapse_recurring(events: list[Event]) -> list[Event]:
    """Drop near-consecutive same-titled events, keeping the earliest."""
    by_title: dict[str, list[Event]] = {}
    for e in events:
        by_title.setdefault(e.title, []).append(e)
    kept: list[Event] = []
    for group in by_title.values():
        if len(group) == 1:
            kept.append(group[0])
            continue
        group.sort(key=lambda x: x.start)
        prev: dt.date | None = None
        for ev in group:
            try:
                cur = dt.date.fromisoformat(ev.start[:10])
            except ValueError:
                kept.append(ev)
                continue
            if prev is None or (cur - prev).days > _CLUSTER_GAP_DAYS:
                kept.append(ev)
            prev = cur
    kept.sort(key=lambda x: x.start)
    return kept


def _parse_date(s: str | None) -> str | None:
    if not s:
        return None
    m = _DATETIME_RE.match(s.strip())
    return m.group(1) if m else None


def _is_vancouver(event: dict) -> bool:
    """Keep events that are either Vancouver-tagged or campus-agnostic.

    The site is shared between Vancouver and Okanagan campuses; we drop
    events that are *only* Okanagan-tagged.
    """
    cats = event.get("categories") or []
    if not cats:
        return True  # untagged → assume general UBC
    saw_okanagan = False
    saw_vancouver = False
    for c in cats:
        name = (c.get("name") or "").lower()
        if "okanagan" in name:
            saw_okanagan = True
        if "vancouver" in name:
            saw_vancouver = True
    if saw_vancouver:
        return True
    if saw_okanagan:
        return False
    return True


def _clean_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


# Placeholder venue strings that aren't real locations — drop them so the
# upcoming-list doesn't show "See Description" under half the events.
_NON_LOCATIONS = {
    "see description",
    "see event details",
    "tbd",
    "to be determined",
    "varies",
}


def _filter_location(loc: str | None) -> str | None:
    if not loc:
        return None
    if loc.strip().lower() in _NON_LOCATIONS:
        return None
    return loc


def _event_from_payload(raw: dict) -> Event | None:
    start = _parse_date(raw.get("start_date"))
    if not start:
        return None
    end = _parse_date(raw.get("end_date"))
    if end == start:
        end = None
    title = _clean_html(raw.get("title") or "")
    if not title:
        return None
    url = (raw.get("url") or "").strip()
    if not url:
        return None
    image: str | None = None
    img = raw.get("image")
    if isinstance(img, dict):
        image = (img.get("url") or "").strip() or None
    elif isinstance(img, str):
        image = img.strip() or None
    venue = raw.get("venue")
    location: str | None = None
    if isinstance(venue, dict):
        loc_raw = _clean_html(venue.get("venue") or "")
        location = _filter_location(loc_raw or None)
    return Event(
        url=url,
        title=title,
        start=start,
        end=end,
        image=image,
        location=location,
        all_day=bool(raw.get("all_day")),
    )


async def scrape(
    *,
    refresh: bool,
    rate: float,
    start_date: str,
    max_pages: int,
    per_page: int,
) -> list[Event]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out: list[Event] = []
    seen: set[str] = set()
    async with make_async_client() as raw_client:
        client = RateLimitedClient(raw_client, min_interval=rate)
        for page in range(1, max_pages + 1):
            url = (
                f"{API_BASE}?per_page={per_page}"
                f"&start_date={start_date}&page={page}"
            )
            try:
                body = await client.get_html(url, force=refresh)
            except Exception as exc:  # noqa: BLE001
                log.error("FAILED page %d: %s", page, exc)
                break
            try:
                payload = json.loads(body)
            except json.JSONDecodeError as exc:
                log.error("Bad JSON from page %d: %s", page, exc)
                break
            events = payload.get("events") or []
            if not events:
                break
            kept = 0
            for raw in events:
                if not _is_vancouver(raw):
                    continue
                ev = _event_from_payload(raw)
                if ev is None:
                    continue
                if ev.url in seen:
                    continue
                seen.add(ev.url)
                out.append(ev)
                kept += 1
            log.info(
                "Page %d: %d events, kept %d (running total %d)",
                page, len(events), kept, len(out),
            )
            if not payload.get("next_rest_url"):
                break
    out.sort(key=lambda e: e.start)
    out = _collapse_recurring(out)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--start-date",
        default=dt.date.today().isoformat(),
        help="Earliest event start date (YYYY-MM-DD). Default: today.",
    )
    ap.add_argument(
        "--max-pages",
        type=int,
        default=4,
        help="Max API pages to fetch (default 4 × 50 = up to 200 events)",
    )
    ap.add_argument(
        "--per-page",
        type=int,
        default=50,
        help="Events per API page (max 50)",
    )
    ap.add_argument("--refresh", action="store_true", help="Bypass HTML cache")
    ap.add_argument(
        "--rate",
        type=float,
        default=1.0,
        help="Minimum seconds between requests (default 1.0)",
    )
    ap.add_argument("--output", type=Path, default=OUTPUT_FILE)
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    configure_logging(args.verbose)
    events = asyncio.run(
        scrape(
            refresh=args.refresh,
            rate=args.rate,
            start_date=args.start_date,
            max_pages=args.max_pages,
            per_page=args.per_page,
        )
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps([asdict(e) for e in events], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    log.info("Wrote %d events to %s", len(events), args.output)


if __name__ == "__main__":
    main()
