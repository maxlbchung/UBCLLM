"""Pull UBC Vancouver course descriptions from the calendar's Drupal JSON:API.

The calendar at vancouver.calendar.ubc.ca runs on Drupal with JSON:API
enabled, so every course is a structured node at `/jsonapi/node/course` — no
HTML scraping. This is the SAME entity store the website renders from, so it's
authoritative and strictly more complete than crawling the rendered
subject-index pages (the old approach silently dropped courses whose heading
didn't fit a regex, and collapsed cross-listings via canonical-code dedup).

Caveat that drives the parsing here: UBC does NOT populate the dedicated
structured fields (`field_course_prerequisite`, `field_course_co_requistite`,
`field_course_equivalency`). They are null on every course. The entire
human-readable blurb — description PLUS the inline "Prerequisite:" /
"Corequisite:" / "Equivalency:" / "Recommended:" labels — lives in
`field_course_description`. So we run the exact same `split_description()`
parser the HTML scraper used, just on a clean, label-intact source string
instead of a scraped <p>. Output schema is unchanged so the pipeline and web
app are unaffected.

The subject (e.g. "CPSC") is a relationship — `field_course_code` points to a
`taxonomy_term--subject` whose `name` is the raw code ("CPSC_V"). We request
`include=field_course_code` and resolve it from each page's `included` array.

Output: scraper/output/courses.json — one record per course.

Usage:
    uv run scrape_courses.py                 # full pull (~190 pages)
    uv run scrape_courses.py --subject CPSC  # one subject (debug)
    uv run scrape_courses.py --limit 50      # first N nodes (debug)
    uv run scrape_courses.py --refresh       # ignore cache, re-fetch
"""
from __future__ import annotations

import argparse
import asyncio
import html
import json
import re
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

from selectolax.parser import HTMLParser

from common import (
    BASE_URL,
    CRAWL_DELAY,
    OUTPUT_DIR,
    RateLimitedClient,
    configure_logging,
    log,
    make_async_client,
)

OUTPUT_FILE = OUTPUT_DIR / "courses.json"

# JSON:API course listing. `include` resolves the subject taxonomy term inline;
# `sort` makes offset pagination stable (and re-runs byte-deterministic).
COURSE_ENDPOINT = (
    f"{BASE_URL}/jsonapi/node/course"
    "?include=field_course_code"
    "&sort=drupal_internal__nid"
    "&page[limit]=50"
)

# Labels that introduce structured fields embedded in the description text.
# Order matters: longer/plural forms first so the regex prefers them.
FIELD_LABELS = [
    ("prerequisites", r"Pre-?requisites?"),
    ("corequisites", r"Co-?requisites?"),
    ("equivalency", r"Equivalency|Equivalent"),
    ("recommended", r"Recommended"),
]


@dataclass
class Course:
    code: str           # canonical "CPSC 110"
    raw_code: str       # as stored: "CPSC_V 110"
    subject: str        # "CPSC"
    number: str         # "110"
    title: str
    credits: str | None         # raw credit string, e.g. "4" or "1-6"
    credits_value: int | None   # parsed integer when unambiguous
    credit_d_fail: bool | None  # True = eligible for Credit/D/Fail grading (UBC field_course_crdfail)
    description: str
    prerequisites: str | None
    corequisites: str | None
    equivalency: str | None
    recommended: str | None
    url: str | None     # individual course page on the calendar


# ---------- Field parsing (unchanged from the HTML scraper) ----------

def parse_credits(s: str) -> tuple[str, int | None]:
    raw = s.strip()
    m = re.fullmatch(r"\s*(\d+)\s*", raw)
    return raw, int(m.group(1)) if m else None


def split_description(text: str) -> dict[str, str | None]:
    """Pull labeled fields (prereqs etc.) out of the description paragraph."""
    out: dict[str, str | None] = {
        "description": text.strip(),
        "prerequisites": None,
        "corequisites": None,
        "equivalency": None,
        "recommended": None,
    }
    if not text:
        return out

    label_pattern = "|".join(p for _, p in FIELD_LABELS)
    splitter = re.compile(rf"\s*(?P<label>{label_pattern})\s*:\s*", re.IGNORECASE)

    parts = splitter.split(text)
    # parts: [desc, label1, value1, label2, value2, ...]
    out["description"] = parts[0].strip()

    for i in range(1, len(parts), 2):
        label_text = parts[i].lower()
        value = parts[i + 1].strip() if i + 1 < len(parts) else ""
        # Trim trailing period/whitespace; values may run into the next sentence.
        value = value.rstrip().rstrip(".").strip()
        for key, pattern in FIELD_LABELS:
            if re.fullmatch(pattern, label_text, re.IGNORECASE):
                # If the same field appears twice, keep the longer one.
                existing = out.get(key)
                if existing is None or len(value) > len(existing):
                    out[key] = value
                break
    return out


# ---------- JSON:API field helpers ----------

def normalize_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def field_text(value: object) -> str:
    """Coerce a JSON:API attribute to clean plain text. Handles plain strings,
    formatted-text objects ({value, processed, format}), stray HTML, and
    HTML entities — so the output matches the HTML scraper's .text() result."""
    if value is None:
        return ""
    if isinstance(value, dict):
        value = value.get("processed") or value.get("value") or ""
    s = str(value)
    if "<" in s:  # defensive: a formatted field could carry markup
        s = HTMLParser(s).text(separator=" ", strip=True) or ""
    return html.unescape(s)


def clean_credit(value: object) -> str | None:
    """Strip the wrapping parens UBC stores credits in: "(4)" -> "4"."""
    if value is None:
        return None
    s = field_text(value).strip()
    m = re.fullmatch(r"\((.*)\)", s)
    if m:
        s = m.group(1).strip()
    return s or None


def build_course(
    node: dict, subject_map: dict[str, str]
) -> tuple[Course | None, str | None]:
    """Turn one node--course record into a Course, or (None, reason) if it's a
    junk node we should skip (missing subject or number)."""
    attrs = node.get("attributes") or {}
    rels = node.get("relationships") or {}
    rel = (rels.get("field_course_code") or {}).get("data")
    subj_name = subject_map.get(rel.get("id")) if isinstance(rel, dict) and rel else None
    if not subj_name:
        return None, "no_subject"

    computed = attrs.get("field_computed_course_number")
    num_int = attrs.get("field_course_number")
    number = ""
    if computed not in (None, ""):
        number = str(computed).strip()
    elif num_int not in (None, ""):
        number = str(num_int).strip()
    if not number:
        return None, "no_number"

    subject_clean = subj_name.split("_", 1)[0]
    code = f"{subject_clean} {number}"
    raw_code = f"{subj_name} {number}"

    title = normalize_ws(field_text(attrs.get("field_course_title")))
    desc = normalize_ws(field_text(attrs.get("field_course_description")))
    fields = split_description(desc)

    crdfail = attrs.get("field_course_crdfail")
    credit_d_fail = crdfail if isinstance(crdfail, bool) else None

    credit_raw = clean_credit(attrs.get("field_course_credit"))
    if credit_raw:
        credits_raw_str, credits_int = parse_credits(credit_raw)
        credits = credits_raw_str or None
        credits_value = credits_int
    else:
        credits, credits_value = None, None

    path = attrs.get("path") or {}
    alias = path.get("alias") if isinstance(path, dict) else None
    url = f"{BASE_URL}{alias}" if alias else None

    return (
        Course(
            code=code,
            raw_code=raw_code,
            subject=subject_clean,
            number=number,
            title=title,
            credits=credits,
            credits_value=credits_value,
            credit_d_fail=credit_d_fail,
            description=fields["description"],
            prerequisites=fields["prerequisites"],
            corequisites=fields["corequisites"],
            equivalency=fields["equivalency"],
            recommended=fields["recommended"],
            url=url,
        ),
        None,
    )


def _sort_key(c: Course) -> tuple:
    m = re.match(r"(\d+)(.*)", c.number)
    n = int(m.group(1)) if m else 0
    suffix = (m.group(2) if m else c.number) or ""
    return (c.subject, n, suffix, c.code)


# ---------- Fetch + assemble ----------

async def fetch_nodes(
    *, subject: str | None, limit: int | None, refresh: bool, rate: float
) -> tuple[list[dict], dict[str, str]]:
    """Page through node/course (following links.next), accumulating raw nodes
    and a {subject-term-uuid -> name} map from each page's `included` array."""
    seed = COURSE_ENDPOINT
    if subject:
        name = subject.upper()
        if not name.endswith("_V"):
            name += "_V"
        seed += f"&filter[field_course_code.name]={name}"

    nodes: list[dict] = []
    subject_map: dict[str, str] = {}

    async with make_async_client(accept="application/vnd.api+json") as raw_client:
        client = RateLimitedClient(raw_client, min_interval=rate)
        url: str | None = seed
        pages = 0
        while url:
            doc = await client.get_json(url, force=refresh)
            for inc in (doc.get("included") or []):
                if inc.get("type") == "taxonomy_term--subject":
                    nm = (inc.get("attributes") or {}).get("name")
                    if nm:
                        subject_map[inc.get("id")] = nm
            data = doc.get("data") or []
            nodes.extend(data)
            pages += 1
            log.info("page %d: +%d nodes (%d total)", pages, len(data), len(nodes))
            if limit and len(nodes) >= limit:
                nodes = nodes[:limit]
                break
            nxt = (doc.get("links") or {}).get("next")
            url = nxt.get("href") if isinstance(nxt, dict) else nxt

    log.info("Fetched %d course nodes across %d pages", len(nodes), pages)
    return nodes, subject_map


def assemble(nodes: list[dict], subject_map: dict[str, str]) -> list[Course]:
    skipped: Counter[str] = Counter()
    by_code: dict[str, Course] = {}
    dupes = 0
    empty_title = 0

    for node in nodes:
        course, reason = build_course(node, subject_map)
        if course is None:
            skipped[reason] += 1
            continue
        if not course.title:
            empty_title += 1
        if course.code in by_code:
            dupes += 1
            continue
        by_code[course.code] = course

    courses = sorted(by_code.values(), key=_sort_key)
    log.info("Assembled %d unique courses from %d nodes", len(courses), len(nodes))
    if skipped:
        log.info("  skipped (junk nodes): %s", dict(skipped))
    if dupes:
        log.info("  duplicate canonical codes collapsed: %d", dupes)
    if empty_title:
        log.info("  kept with empty title: %d", empty_title)
    return courses


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--subject", help="Filter to a single subject code, e.g. CPSC")
    ap.add_argument("--limit", type=int, help="Stop after N course nodes (debug)")
    ap.add_argument(
        "--refresh",
        action="store_true",
        help="Bypass the on-disk cache and re-fetch every page",
    )
    ap.add_argument(
        "--rate",
        type=float,
        default=CRAWL_DELAY,
        help=f"Minimum seconds between requests (default {CRAWL_DELAY}, "
        "per the calendar's robots.txt Crawl-delay)",
    )
    ap.add_argument("--output", type=Path, default=OUTPUT_FILE)
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    configure_logging(args.verbose)

    nodes, subject_map = asyncio.run(
        fetch_nodes(
            subject=args.subject,
            limit=args.limit,
            refresh=args.refresh,
            rate=args.rate,
        )
    )
    courses = assemble(nodes, subject_map)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = [asdict(c) for c in courses]
    args.output.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    log.info("Wrote %d courses to %s", len(payload), args.output)


if __name__ == "__main__":
    main()
