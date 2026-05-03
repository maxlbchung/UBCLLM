"""Crawl UBC Vancouver course descriptions into a single JSON file.

Index page:  https://vancouver.calendar.ubc.ca/course-descriptions/courses-subject
For each subject (~264 of them) the index links to a single page with all
courses for that subject as <li> blocks of:

    <h3>CPSC_V 110 (4) <strong>Computation, Programs, and Programming</strong></h3>
    <p>Fundamental program and computation structures. ... Prerequisite: ...
       Corequisite: ...</p>

Output: scraper/output/courses.json — one record per course.

Usage:
    uv run scrape_courses.py                 # full crawl
    uv run scrape_courses.py --subject CPSC  # one subject
    uv run scrape_courses.py --limit 3       # first 3 subjects (debug)
    uv run scrape_courses.py --refresh       # ignore cache, re-fetch HTML
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urljoin

from selectolax.parser import HTMLParser, Node

from common import (
    BASE_URL,
    OUTPUT_DIR,
    RateLimitedClient,
    configure_logging,
    log,
    make_async_client,
)

INDEX_URL = f"{BASE_URL}/course-descriptions/courses-subject"
OUTPUT_FILE = OUTPUT_DIR / "courses.json"

# Matches the leading "SUBJ_V 123" or "SUBJ 123" portion of an h3 title.
COURSE_HEAD_RE = re.compile(
    r"^(?P<subject>[A-Z][A-Z0-9]*(?:_[A-Z])?)\s+"
    r"(?P<number>\d{2,4}[A-Z]?)\s*"
    r"\((?P<credits>[^)]*)\)\s*"
    r"(?P<title>.+)$",
    re.DOTALL,
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
    raw_code: str       # as printed: "CPSC_V 110"
    subject: str        # "CPSC"
    number: str         # "110"
    title: str
    credits: str | None         # raw credit string, e.g. "4" or "1-6"
    credits_value: int | None   # parsed integer when unambiguous
    description: str
    prerequisites: str | None
    corequisites: str | None
    equivalency: str | None
    recommended: str | None
    url: str            # subject page the course was scraped from


# ---------- Index parsing ----------

def parse_index(html: str) -> list[str]:
    """Return absolute URLs of every subject page linked from the index."""
    tree = HTMLParser(html)
    seen: set[str] = set()
    urls: list[str] = []
    for a in tree.css("a"):
        href = (a.attributes.get("href") or "").strip()
        if "/course-descriptions/subject/" not in href:
            continue
        full = urljoin(BASE_URL, href.split("#", 1)[0])
        if full in seen:
            continue
        seen.add(full)
        urls.append(full)
    return urls


def filter_subjects(urls: list[str], subject: str | None) -> list[str]:
    if not subject:
        return urls
    needle = subject.lower()
    return [u for u in urls if needle in u.rsplit("/", 1)[-1]]


# ---------- Subject-page parsing ----------

def _h3_text(node: Node) -> str:
    """Flattened text from an h3, with the <strong> title separated by a space."""
    raw = node.text(separator=" ", strip=True)
    return re.sub(r"\s+", " ", raw)


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


def parse_subject_page(html: str, source_url: str) -> list[Course]:
    tree = HTMLParser(html)
    courses: list[Course] = []
    seen_codes: set[str] = set()

    # Most subject pages wrap courses in <ol><li>...</li></ol>, but a few use
    # <ul> or have stray <h3>s outside of a list. Search by h3 to be robust.
    for h3 in tree.css("h3"):
        head = _h3_text(h3)
        m = COURSE_HEAD_RE.match(head)
        if not m:
            continue
        subject_raw = m.group("subject")
        number = m.group("number")
        title = m.group("title").strip()
        credits_raw, credits_int = parse_credits(m.group("credits"))

        # Find the description paragraph: walk forward to the next non-empty
        # <p> sibling (or the next <p> within the same <li> parent).
        desc_node = _next_paragraph(h3)
        desc_text = desc_node.text(separator=" ", strip=True) if desc_node else ""
        desc_text = re.sub(r"\s+", " ", desc_text)
        fields = split_description(desc_text)

        subject_clean = subject_raw.split("_", 1)[0]
        canonical = f"{subject_clean} {number}"
        if canonical in seen_codes:
            continue
        seen_codes.add(canonical)

        courses.append(
            Course(
                code=canonical,
                raw_code=f"{subject_raw} {number}",
                subject=subject_clean,
                number=number,
                title=title,
                credits=credits_raw or None,
                credits_value=credits_int,
                description=fields["description"],
                prerequisites=fields["prerequisites"],
                corequisites=fields["corequisites"],
                equivalency=fields["equivalency"],
                recommended=fields["recommended"],
                url=source_url,
            )
        )
    return courses


def _next_paragraph(h3: Node) -> Node | None:
    """Return the description paragraph that follows an h3 course heading.

    Strategy:
    1. If h3 is wrapped in <li>, prefer the first <p> inside that <li>.
    2. Otherwise walk forward through following siblings.
    """
    parent = h3.parent
    if parent and parent.tag == "li":
        for p in parent.css("p"):
            return p

    sib = h3.next
    while sib is not None:
        if sib.tag == "p":
            return sib
        sib = sib.next
    return None


# ---------- Orchestration ----------

async def scrape(
    *,
    subject: str | None,
    limit: int | None,
    refresh: bool,
    rate: float,
) -> list[Course]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    async with make_async_client() as raw_client:
        client = RateLimitedClient(raw_client, min_interval=rate)

        log.info("Fetching subject index: %s", INDEX_URL)
        index_html = await client.get_html(INDEX_URL, force=refresh)
        all_urls = parse_index(index_html)
        log.info("Found %d subject pages on the index", len(all_urls))

        urls = filter_subjects(all_urls, subject)
        if subject and not urls:
            log.warning("No subjects matched filter %r", subject)
        if limit is not None:
            urls = urls[:limit]
        log.info("Will scrape %d subject pages", len(urls))

        all_courses: list[Course] = []
        for i, url in enumerate(urls, 1):
            try:
                html = await client.get_html(url, force=refresh)
            except Exception as exc:  # noqa: BLE001
                log.error("[%d/%d] FAILED %s: %s", i, len(urls), url, exc)
                continue
            courses = parse_subject_page(html, url)
            log.info("[%d/%d] %s -> %d courses", i, len(urls), url, len(courses))
            all_courses.extend(courses)

    return all_courses


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--subject", help="Filter to a single subject code, e.g. CPSC")
    ap.add_argument("--limit", type=int, help="Only scrape the first N subjects")
    ap.add_argument(
        "--refresh",
        action="store_true",
        help="Bypass the on-disk HTML cache and re-fetch every page",
    )
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

    courses = asyncio.run(
        scrape(
            subject=args.subject,
            limit=args.limit,
            refresh=args.refresh,
            rate=args.rate,
        )
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = [asdict(c) for c in courses]
    args.output.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    log.info("Wrote %d courses to %s", len(payload), args.output)


if __name__ == "__main__":
    main()
