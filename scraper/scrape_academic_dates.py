"""Scrape https://vancouver.calendar.ubc.ca/dates-and-deadlines.

The page is several wide tables — each row is an event label (``Start``,
``Exams Start``, ``Term 1 Course``...) and each *column* is a term or
session. Term context comes from the column ``<th>`` text like
``"Term 1 (May – June, 2026)"``. Some date cells include explicit years
(``"May 25, 2026"``), others don't (``"Monday, May 11"``) — when missing,
we infer the year from the column header.

The output collapses each (row, column) pair into a single record:
``event = "{row_label} — {column_header_short}"``, ``term = column header``.

Output: scraper/output/academic_dates.json
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from selectolax.parser import HTMLParser, Node

from common import (
    OUTPUT_DIR,
    RateLimitedClient,
    configure_logging,
    log,
    make_async_client,
)

SEED_URL = "https://vancouver.calendar.ubc.ca/dates-and-deadlines"
OUTPUT_FILE = OUTPUT_DIR / "academic_dates.json"

_MONTHS = (
    "January|February|March|April|May|June|July|August|September|October|November|December"
    "|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"
)
# Captures both single dates and ranges. Examples:
#   "Tuesday, May 12, 2026"
#   "May 12, 2026"
#   "May 12–August 14, 2026"
#   "May 12 - 14, 2026"
#   "May 12 to June 2, 2026"
_DATE_RE = re.compile(
    rf"(?P<m1>{_MONTHS})\s+(?P<d1>\d{{1,2}})"
    rf"(?:\s*(?:[–\-]|to)\s*(?:(?P<m2>{_MONTHS})\s+)?(?P<d2>\d{{1,2}}))?"
    rf",?\s+(?P<y>\d{{4}})",
)

_MONTH_NUM = {
    "jan": 1, "january": 1,
    "feb": 2, "february": 2,
    "mar": 3, "march": 3,
    "apr": 4, "april": 4,
    "may": 5,
    "jun": 6, "june": 6,
    "jul": 7, "july": 7,
    "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10,
    "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}


@dataclass
class AcademicDate:
    term: str
    event: str
    dateText: str
    start: str  # 'YYYY-MM-DD'
    end: str | None = None


def _parse_iso(text: str) -> tuple[str, str | None] | None:
    m = _DATE_RE.search(text)
    if not m:
        return None
    y = int(m.group("y"))
    m1 = _MONTH_NUM[m.group("m1").lower()]
    d1 = int(m.group("d1"))
    start = f"{y:04d}-{m1:02d}-{d1:02d}"
    d2 = m.group("d2")
    if not d2:
        return start, None
    m2_raw = m.group("m2")
    m2 = _MONTH_NUM[m2_raw.lower()] if m2_raw else m1
    end = f"{y:04d}-{m2:02d}-{int(d2):02d}"
    return start, end


def _clean(text: str) -> str:
    # Collapse whitespace, normalize NBSP to ASCII space, drop footnote
    # superscripts (digits trailing a date range like "November 9 – 11¹").
    text = (text or "").replace("\xa0", " ").replace("­", "")
    return re.sub(r"\s+", " ", text).strip()


def _year_in(text: str) -> int | None:
    m = re.search(r"(20\d{2})", text or "")
    return int(m.group(1)) if m else None


def _parse_date_cell(cell: str, fallback_year: int | None) -> tuple[str, str | None] | None:
    """Try to parse a date or date range out of a table cell.

    If the cell has no explicit year, fall back to ``fallback_year`` (from
    the column header). Returns ``(start_iso, end_iso_or_None)`` or None.
    """
    cell = _clean(cell)
    # Strip trailing Unicode-superscript footnote digits ("Nov 9 – 11¹").
    cell = re.sub(r"[¹²³⁴⁵⁶⁷⁸⁹⁰]+", "", cell)

    parsed = _parse_iso(cell)
    if parsed:
        return _clamp_days(parsed)
    if fallback_year is None:
        return None
    # No year in the cell text — borrow from the column header.
    augmented = f"{cell}, {fallback_year}"
    parsed = _parse_iso(augmented)
    return _clamp_days(parsed) if parsed else None


def _clamp_days(pair: tuple[str, str | None]) -> tuple[str, str | None] | None:
    """Repair dates whose day-of-month accidentally absorbed a footnote.

    Some UBC tables render footnotes by appending an ASCII digit directly
    after the day number with no separator ("November 9 – 111" really
    means "November 9 – 11"). If a parsed day is > 31, peel digits from
    the right until it's a valid day-of-month.
    """
    def _fix(iso: str) -> str:
        y, m, d = iso.split("-")
        di = int(d)
        while di > 31 and len(d) > 1:
            d = d[:-1]
            di = int(d)
        if di < 1 or di > 31:
            return ""
        return f"{y}-{m}-{int(d):02d}"

    start = _fix(pair[0])
    if not start:
        return None
    end_iso = pair[1]
    end = _fix(end_iso) if end_iso else None
    if end_iso and not end:
        end = None
    return start, end


def _shorten_term(term: str) -> str:
    """Trim a column header like 'Term 1 (May – June, 2026)' to a short tag."""
    return re.sub(r"\s+", " ", term).strip()


def parse(html: str) -> list[AcademicDate]:
    tree = HTMLParser(html)
    body = tree.body or tree.root
    if body is None:
        return []
    out: list[AcademicDate] = []
    seen: set[tuple[str, str, str]] = set()  # (term, event, start)

    for tbl in body.css("table"):
        # Column headers come from <thead><th>; first th is usually the
        # row-label column and is empty.
        ths = [_clean(th.text(separator=" ")) for th in tbl.css("thead th")]
        if len(ths) < 2:
            # Some tables have no <thead> — skip them (they're not the
            # main content tables).
            continue
        term_headers = ths  # keep indices aligned with td positions
        for tr in tbl.css("tbody tr"):
            tds = tr.css("td")
            if len(tds) < 2:
                continue
            row_label = _clean(tds[0].text(separator=" "))
            if not row_label:
                continue
            for i, td in enumerate(tds[1:], start=1):
                if i >= len(term_headers):
                    break
                col_header = term_headers[i]
                cell_text = _clean(td.text(separator=" "))
                if not cell_text:
                    continue
                parsed = _parse_date_cell(
                    cell_text, fallback_year=_year_in(col_header)
                )
                if not parsed:
                    log.debug(
                        "Skip cell %r in %r / %r", cell_text, row_label, col_header
                    )
                    continue
                start, end = parsed
                # Drop "teaching days = 28" style rows where the regex
                # spuriously matched nothing useful — but _parse_date_cell
                # already returns None for those.
                event_name = f"{row_label} — {_shorten_term(col_header)}"
                key = (col_header, event_name, start)
                if key in seen:
                    continue
                seen.add(key)
                out.append(
                    AcademicDate(
                        term=_shorten_term(col_header),
                        event=row_label,
                        dateText=cell_text,
                        start=start,
                        end=end,
                    )
                )
    out.sort(key=lambda r: (r.start, r.term, r.event))
    return _drop_long_windows(out)


# Multi-week academic ranges (>7 days) come from the middle column of
# UBC's drop-deadline tables — they describe a "self-service available"
# window rather than an actionable deadline, and paint themselves on
# every day they cover (20–60 calendar days each). The actionable
# boundaries are captured by the first/third columns as single-date
# deadlines, so we drop these here at the scrape step.
_MAX_RANGE_DAYS = 7


def _drop_long_windows(items: list[AcademicDate]) -> list[AcademicDate]:
    kept: list[AcademicDate] = []
    for it in items:
        if it.end:
            try:
                span = (
                    dt.date.fromisoformat(it.end)
                    - dt.date.fromisoformat(it.start)
                ).days
            except ValueError:
                span = 0
            if span > _MAX_RANGE_DAYS:
                continue
        kept.append(it)
    return kept


async def scrape(*, refresh: bool, rate: float) -> list[AcademicDate]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    async with make_async_client() as raw_client:
        client = RateLimitedClient(raw_client, min_interval=rate)
        html = await client.get_html(SEED_URL, force=refresh)
    items = parse(html)
    log.info("Parsed %d academic dates from %s", len(items), SEED_URL)
    return items


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
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
    items = asyncio.run(scrape(refresh=args.refresh, rate=args.rate))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps([asdict(i) for i in items], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    log.info("Wrote %d academic dates to %s", len(items), args.output)


if __name__ == "__main__":
    main()
