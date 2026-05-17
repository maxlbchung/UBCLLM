"""Merge events / academic_dates / holidays into web/public/data/calendar.json.

Each scraper in ``scraper/output/`` emits a source-specific shape; this
script normalizes them into a single ``CalendarItem`` schema, sorts by
date, drops items older than 30 days, and writes the result as the only
calendar payload the frontend reads.

Stdlib-only (no extra pipeline dependencies needed).

Output: ``web/public/data/calendar.json`` — ``{generatedAt, items}``.

Usage:
    uv run build_calendar.py
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRAPER_OUTPUT = ROOT / "scraper" / "output"
WEB_DATA = ROOT / "web" / "public" / "data"

EVENTS_FILE = SCRAPER_OUTPUT / "events.json"
ACADEMIC_FILE = SCRAPER_OUTPUT / "academic_dates.json"
HOLIDAYS_FILE = SCRAPER_OUTPUT / "holidays.json"
OUTPUT_FILE = WEB_DATA / "calendar.json"

# How many days of past items to keep (for week-of-the-year recency).
PAST_WINDOW_DAYS = 30


def _hash(*parts: str) -> str:
    h = hashlib.sha1()
    for p in parts:
        h.update(p.encode("utf-8"))
        h.update(b"|")
    return h.hexdigest()[:10]


def _load(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def _normalize_events(raw: list[dict]) -> list[dict]:
    out: list[dict] = []
    for ev in raw:
        date = (ev.get("start") or "").strip()
        if not date:
            continue
        title = (ev.get("title") or "").strip()
        if not title:
            continue
        item = {
            "id": _hash("event", date, title, ev.get("url") or ""),
            "category": "event",
            "title": title,
            "date": date,
        }
        if ev.get("end"):
            item["endDate"] = ev["end"]
        if ev.get("url"):
            item["url"] = ev["url"]
        if ev.get("location"):
            item["description"] = ev["location"]
        if ev.get("image"):
            item["image"] = ev["image"]
        out.append(item)
    return out


import re

# Row labels from the term-dates tables that are too terse to stand
# alone — when we see one, we synthesize a richer title by combining
# it with the term context ("Start" → "Term 1 2026 — start").
_TERSE_EVENTS = {
    "start", "finish", "exams start", "exams finish", "midterm break",
}

# Keywords that mark a phrase as an action / deadline rather than a
# scope. Used to decide which of (event, term) should be the title —
# the dates-and-deadlines page mixes both layouts: term-dates tables
# have action in the row label, drop-deadline tables have action in
# the column header.
_ACTION_KEYWORDS = (
    "last day", "deadline", "withdraw", "self-service",
    "faculty approval", "drop", "after ", "self serve",
)


def _is_action_phrase(text: str) -> bool:
    s = text.lower()
    return any(kw in s for kw in _ACTION_KEYWORDS)


def _strip_paren_date(term: str) -> str:
    """'Term 1 (May – June, 2026)' → 'Term 1 2026'."""
    m = re.search(r"(20\d{2})", term)
    year = m.group(1) if m else ""
    head = re.sub(r"\s*\([^)]*\)\s*", "", term).strip()
    if year and year not in head:
        return f"{head} {year}".strip()
    return head or term


def _normalize_academic(raw: list[dict]) -> list[dict]:
    out: list[dict] = []
    for r in raw:
        date = (r.get("start") or "").strip()
        if not date:
            continue
        event = (r.get("event") or "").strip()
        term = (r.get("term") or "").strip()
        if not event:
            continue
        clean_term = _strip_paren_date(term) if term else ""

        # Decide which field is the action and which is the scope.
        # Drop-deadline tables: action is in `term` (the column header
        # carries phrases like "Last day to drop…"). Term-dates tables:
        # action is in `event` ("Start", "Finish", …).
        if _is_action_phrase(term) and not _is_action_phrase(event):
            # Two different scopes can share the same action wording on
            # the same day (e.g. one cell covers "Courses starting in
            # May" and another covers "Courses Spanning May to August"
            # for the identical "Student self-service available" action).
            # Put the scope up front in the title so the rows read as
            # distinct instead of an apparent duplicate.
            title = f"{event} — {term}"
            description = ""
        elif event.lower() in _TERSE_EVENTS and clean_term:
            title = f"{clean_term} — {event.lower()}"
            description = ""
        else:
            title = event
            description = clean_term

        item = {
            "id": _hash("academic", date, event, term),
            "category": "academic",
            "title": title,
            "date": date,
        }
        if r.get("end"):
            item["endDate"] = r["end"]
        if description and description.lower() not in title.lower():
            item["description"] = description
        out.append(item)
    return out


def _normalize_holidays(raw: list[dict]) -> list[dict]:
    out: list[dict] = []
    for h in raw:
        date = (h.get("date") or "").strip()
        name = (h.get("name") or "").strip()
        if not date or not name:
            continue
        out.append(
            {
                "id": _hash("holiday", date, name),
                "category": "holiday",
                "title": name,
                "date": date,
            }
        )
    return out


def _prune_past(items: list[dict], today: dt.date) -> list[dict]:
    cutoff = (today - dt.timedelta(days=PAST_WINDOW_DAYS)).isoformat()
    out: list[dict] = []
    for it in items:
        end = it.get("endDate") or it["date"]
        if end >= cutoff:
            out.append(it)
    return out


def build(today: dt.date | None = None) -> dict:
    today = today or dt.date.today()
    items: list[dict] = []
    items.extend(_normalize_events(_load(EVENTS_FILE)))
    items.extend(_normalize_academic(_load(ACADEMIC_FILE)))
    items.extend(_normalize_holidays(_load(HOLIDAYS_FILE)))
    items = _prune_past(items, today)

    # Stable sort: date asc, then category, then title.
    items.sort(key=lambda i: (i["date"], i["category"], i["title"]))

    return {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "items": items,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", type=Path, default=OUTPUT_FILE)
    args = ap.parse_args()

    payload = build()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    counts = {"academic": 0, "holiday": 0, "event": 0}
    for it in payload["items"]:
        counts[it["category"]] = counts.get(it["category"], 0) + 1
    print(
        f"Wrote {len(payload['items'])} items "
        f"(academic={counts['academic']} holiday={counts['holiday']} event={counts['event']}) "
        f"to {args.output}"
    )


if __name__ == "__main__":
    main()
