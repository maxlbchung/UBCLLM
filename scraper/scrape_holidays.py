"""Scrape https://hr.ubc.ca/working-ubc/statutory-holidays.

The page is structured as:

    <h2>2026 statutory holidays</h2>
    <h4>JANUARY</h4>
    <figure><table><tr>
      <td>Thursday, January 1</td>
      <td>New Year's Day</td>
    </tr></table></figure>
    <h4>FEBRUARY</h4>
    <figure><table>...</table></figure>

Year context lives in the ``<h2>`` (or any heading containing a 4-digit
year). Month context comes from each ``<h4>`` (case-insensitive). Each
following ``<table>`` until the next month heading lists holidays as
two-cell rows: dateText / name.

Output: scraper/output/holidays.json
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from selectolax.parser import HTMLParser

from common import (
    OUTPUT_DIR,
    RateLimitedClient,
    configure_logging,
    log,
    make_async_client,
)

SEED_URL = "https://hr.ubc.ca/working-ubc/statutory-holidays"
OUTPUT_FILE = OUTPUT_DIR / "holidays.json"

_MONTH_NUM = {
    "january": 1, "february": 2, "march": 3, "april": 4,
    "may": 5, "june": 6, "july": 7, "august": 8,
    "september": 9, "october": 10, "november": 11, "december": 12,
}
_MONTH_PATTERN = "|".join(_MONTH_NUM)

# Day-of-week + Month + day, possibly with year:
#   "Thursday, January 1"
#   "Monday, December 28, 2026"
_DATE_LINE_RE = re.compile(
    rf"(?:(?P<dow>[A-Za-z]+day)s?,\s*)?"
    rf"(?P<month>{_MONTH_PATTERN})\s+(?P<day>\d{{1,2}})"
    rf"(?:,\s*(?P<year>\d{{4}}))?",
    re.IGNORECASE,
)


@dataclass
class Holiday:
    name: str
    dateText: str
    date: str  # 'YYYY-MM-DD'


def _clean(text: str) -> str:
    text = (text or "").replace("\xa0", " ").replace("’", "'")
    return re.sub(r"\s+", " ", text).strip()


def parse(html: str, *, today: dt.date | None = None) -> list[Holiday]:
    today = today or dt.date.today()
    tree = HTMLParser(html)
    body = tree.body or tree.root
    if body is None:
        return []

    # Resolve the page-level year: take the largest year-like token from
    # any h1/h2 with "statutory holiday" wording, or any heading text.
    page_year: int | None = None
    for h in body.css("h1, h2"):
        text = _clean(h.text())
        m = re.search(r"(20\d{2})", text)
        if m:
            page_year = int(m.group(1))
            break

    # Walk body children in document order, tracking the most recent
    # <h4> month context, and parsing each <table> we encounter.
    current_month: int | None = None

    out: list[Holiday] = []
    seen: set[tuple[str, str]] = set()

    def visit(node) -> None:
        nonlocal current_month
        tag = (node.tag or "").lower()
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            text = _clean(node.text())
            # Pure month heading (case-insensitive, allow stray punctuation).
            stripped = re.sub(r"[^A-Za-z]", "", text).lower()
            if stripped in _MONTH_NUM:
                current_month = _MONTH_NUM[stripped]
                return
        elif tag == "table":
            if current_month is None:
                return
            for tr in node.css("tr"):
                tds = tr.css("td")
                if len(tds) < 2:
                    continue
                date_text = _clean(tds[0].text())
                name = _clean(tds[1].text())
                if not date_text or not name:
                    continue
                m = _DATE_LINE_RE.search(date_text)
                if not m:
                    continue
                month = _MONTH_NUM[m.group("month").lower()]
                # Sanity: trust the table's date column over the column
                # heading if they disagree (e.g., December table with a
                # mid-month "Boxing Day" row).
                day = int(m.group("day"))
                year = int(m.group("year")) if m.group("year") else page_year
                if year is None:
                    # Last-resort fallback: next future occurrence.
                    candidate = dt.date(today.year, month, day)
                    if candidate < today:
                        candidate = dt.date(today.year + 1, month, day)
                    year = candidate.year
                try:
                    iso = dt.date(year, month, day).isoformat()
                except ValueError:
                    log.warning("Bad date: %s-%s-%s", year, month, day)
                    continue
                # Strip trailing asterisk markers (e.g. "Easter Monday*").
                clean_name = re.sub(r"\s*\*+\s*$", "", name)
                key = (iso, clean_name.lower())
                if key in seen:
                    continue
                seen.add(key)
                out.append(Holiday(name=clean_name, dateText=date_text, date=iso))
            return  # don't descend into table children
        for child in node.iter(include_text=False):
            visit(child)

    for child in body.iter(include_text=False):
        visit(child)

    out.sort(key=lambda h: h.date)
    return out


async def scrape(*, refresh: bool, rate: float) -> list[Holiday]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    async with make_async_client() as raw_client:
        client = RateLimitedClient(raw_client, min_interval=rate)
        html = await client.get_html(SEED_URL, force=refresh)
    items = parse(html)
    log.info("Parsed %d holidays from %s", len(items), SEED_URL)
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
    log.info("Wrote %d holidays to %s", len(items), args.output)


if __name__ == "__main__":
    main()
