"""Crawl UBC Vancouver faculty / school / department hub pages.

This scraper owns the *navigation* layer of the calendar: every page that
lives directly under ``/faculties-colleges-and-schools/`` and is a faculty
overview, school overview, or departmental hub — the kind of page that
answers "tell me about the Faculty of Science" or "what is the Sauder
School of Business." Pages that look like a specific degree (Bachelor of …,
Master of …, Doctor of …, certificate, diploma) are explicitly filtered
out — those are owned by ``scrape_degree_programs.py`` and would otherwise
duplicate content with thinner metadata.

Output: scraper/output/faculties.json — one record per page.

Usage:
    uv run scrape_faculties.py                # default depth 2, cap 300 pages
    uv run scrape_faculties.py --depth 3
    uv run scrape_faculties.py --max-pages 50 # debug
    uv run scrape_faculties.py --refresh
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import urljoin, urlparse

from selectolax.parser import HTMLParser, Node

from common import (
    BASE_URL,
    CRAWL_DELAY,
    OUTPUT_DIR,
    RateLimitedClient,
    configure_logging,
    log,
    make_async_client,
)

ROOT_URL = f"{BASE_URL}/faculties-colleges-and-schools"
OUTPUT_FILE = OUTPUT_DIR / "faculties.json"

ALLOWED_PATH_PREFIXES = ("/faculties-colleges-and-schools",)
NODE_PATH_RE = re.compile(r"^/node/\d+/?$")

# Tags whose textual content is navigation chrome, not page body.
STRIP_SELECTORS = (
    "nav",
    "header",
    "footer",
    "script",
    "style",
    "noscript",
    ".breadcrumb",
    ".menu",
    "#sidebar",
    "[role=navigation]",
)

# Title patterns / slug prefixes that mark a page as a degree root, which
# means it belongs to scrape_degree_programs.py — we drop it here so the
# two outputs don't overlap.
DEGREE_TITLE_RE = re.compile(
    r"^("
    r"Bachelor of\b|UBC Bachelor of\b|"
    r"Master of\b|UBC Master of\b|"
    r"Doctor of\b|"
    r"(?:Graduate|Undergraduate) Certificate\b|"
    r"Certificate in\b|Diploma in\b|"
    r"B\.[A-Z]+(?:\.[A-Z]+)*\.|"
    r"M\.[A-Z]+(?:\.[A-Z]+)*\.|"
    r"Ph\.?\s?D\.?|"
    r"MBA\b|MFA\b|MEd\b|MEng\b|MASc\b|MSc\b|MA\b"
    r")",
    re.IGNORECASE,
)
DEGREE_SLUG_PREFIXES = (
    "bachelor-", "basc-", "bsc-", "bsf-", "bils-", "b-i-l-s", "buf-", "b-u-f",
    "master-", "masters-", "mba-", "mfa-", "med-", "meng-", "masc-",
    "ma-", "msc-", "m-arch", "m-ed", "m-eng", "m-sc", "m-a",
    "doctor-", "doctoral-", "phd-", "ph-d", "d-m-a",
    "graduate-certificate-", "undergraduate-certificate-",
    "certificate-", "diploma-",
)

# Hub-page classification. Order matters: most specific first.
HUB_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^the faculty of\b", re.IGNORECASE), "faculty_overview"),
    (re.compile(r"^faculty of\b", re.IGNORECASE), "faculty_overview"),
    (re.compile(r"\bschool of\b", re.IGNORECASE), "school_overview"),
    (re.compile(r"\bdepartment of\b|department$", re.IGNORECASE), "department"),
    (re.compile(r"\bcollege of\b", re.IGNORECASE), "college_overview"),
    (re.compile(r"\bcent(er|re) for\b|institute of\b|institute for\b", re.IGNORECASE), "research_centre"),
    (re.compile(r"\bvantage\b", re.IGNORECASE), "vantage"),
]


@dataclass
class FacultyPage:
    url: str
    title: str
    breadcrumbs: list[str]
    headings: list[str]
    text: str
    depth: int
    kind: str
    discovered_from: str | None = None
    children: list[str] = field(default_factory=list)


# ---------- URL helpers ----------

def is_allowed(url: str) -> bool:
    try:
        p = urlparse(url)
    except ValueError:
        return False
    if p.scheme not in ("http", "https"):
        return False
    if p.netloc and p.netloc != urlparse(BASE_URL).netloc:
        return False
    path = p.path or "/"
    if NODE_PATH_RE.match(path):
        return True
    return any(path == pre or path.startswith(pre + "/") for pre in ALLOWED_PATH_PREFIXES)


def normalize(url: str) -> str:
    p = urlparse(url)
    netloc = p.netloc or urlparse(BASE_URL).netloc
    path = p.path.rstrip("/") or "/"
    return f"{p.scheme or 'https'}://{netloc}{path}"


def looks_like_degree(url: str, title: str) -> bool:
    slug = urlparse(url).path.rsplit("/", 1)[-1].lower()
    if any(slug.startswith(pre) for pre in DEGREE_SLUG_PREFIXES):
        return True
    if title and DEGREE_TITLE_RE.match(title):
        return True
    return False


def classify_hub(title: str) -> str:
    if not title:
        return "other"
    for pat, kind in HUB_RULES:
        if pat.search(title):
            return kind
    return "other"


# ---------- Content extraction ----------

def canonical_url(tree: HTMLParser, fallback: str) -> str:
    link = tree.css_first('link[rel="canonical"]')
    if link is not None:
        href = (link.attributes.get("href") or "").strip()
        if href:
            return normalize(urljoin(fallback, href))
    return normalize(fallback)


def extract_title(tree: HTMLParser) -> str:
    h1 = tree.css_first("h1")
    if h1 is not None:
        t = h1.text(strip=True)
        if t:
            return re.sub(r"\s+", " ", t)
    title = tree.css_first("title")
    if title is not None:
        return re.sub(r"\s+", " ", title.text(strip=True))
    return ""


def extract_breadcrumbs(tree: HTMLParser) -> list[str]:
    out: list[str] = []
    for sel in (".breadcrumb a", "nav.breadcrumb a", "[aria-label=Breadcrumb] a"):
        for a in tree.css(sel):
            t = a.text(strip=True)
            if t:
                out.append(t)
        if out:
            break
    return out


def _content_root(tree: HTMLParser) -> Node:
    for sel in ("main", "article", "[role=main]", ".field--name-body", "#main-content"):
        node = tree.css_first(sel)
        if node is not None:
            return node
    return tree.body or tree.root  # fallback


def _strip_chrome(node: Node) -> None:
    for sel in STRIP_SELECTORS:
        for chrome in node.css(sel):
            chrome.decompose()


_BODY_TAGS = {"p", "li", "h2", "h3", "h4"}


def _walk_document_order(node: Node):
    """Depth-first descendant walk yielding nodes in document order.

    selectolax's `.css(selector_a, selector_b, ...)` returns elements
    grouped by selector, not interleaved by DOM position — so it can't
    be used when the relative order of different tags matters. This
    walker uses the child/next linked-list to do a true DFS.
    """
    child = node.child
    while child is not None:
        yield child
        if child.tag != "-text":
            yield from _walk_document_order(child)
        child = child.next


def extract_body(tree: HTMLParser) -> tuple[str, list[str]]:
    """Extract body text + heading list. Headings are emitted inline in the
    body stream with Markdown-style level markers (`##` h2, `###` h3,
    `####` h4) so the chunking pipeline can section the text by header.
    See the matching docstring in scrape_degree_programs.py for the full
    rationale."""
    root = _content_root(tree)
    _strip_chrome(root)
    for sel in (".anchor-invisible", ".sr-only", "a.anchor"):
        for n in root.css(sel):
            n.decompose()
    headings: list[str] = []
    blocks: list[str] = []
    for el in _walk_document_order(root):
        tag = el.tag
        if tag not in _BODY_TAGS:
            continue
        # Skip nested body tags (e.g. <td><p>x</p></td>) so we don't
        # emit "x" twice — see comment in scrape_degree_programs.py.
        anc = el.parent
        nested = False
        while anc is not None and anc is not root:
            if anc.tag in _BODY_TAGS:
                nested = True
                break
            anc = anc.parent
        if nested:
            continue
        t = el.text(separator=" ", strip=True)
        if not t:
            continue
        t = re.sub(r"\s+", " ", t)
        if tag in ("h2", "h3", "h4"):
            headings.append(t)
            marker = "#" * int(tag[1])
            blocks.append(f"{marker} {t}")
        else:
            blocks.append(t)
    text = "\n".join(blocks).strip()
    return text, headings


def extract_links(tree: HTMLParser, base: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for a in tree.css("a"):
        href = (a.attributes.get("href") or "").strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        full = normalize(urljoin(base, href.split("#", 1)[0]))
        if not is_allowed(full):
            continue
        if full in seen:
            continue
        seen.add(full)
        out.append(full)
    return out


# ---------- Crawl ----------

async def crawl(
    *,
    start: str,
    depth: int,
    max_pages: int,
    refresh: bool,
    rate: float,
) -> list[FacultyPage]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    pages: dict[str, FacultyPage] = {}
    skipped_degree = 0

    async with make_async_client() as raw_client:
        client = RateLimitedClient(raw_client, min_interval=rate)

        queue: deque[tuple[str, int, str | None]] = deque(
            [(normalize(start), 0, None)]
        )
        visited: set[str] = set()

        while queue and len(pages) < max_pages:
            url, d, parent = queue.popleft()
            if url in visited:
                continue
            visited.add(url)

            try:
                html = await client.get_html(url, force=refresh)
            except Exception as exc:  # noqa: BLE001
                log.error("FAILED %s: %s", url, exc)
                continue

            tree = HTMLParser(html)
            cano = canonical_url(tree, url)
            if cano != url:
                visited.add(cano)
            if cano in pages:
                continue

            title = extract_title(tree)

            # Drop degree-looking pages — they belong to scrape_degree_programs.py.
            # We still want to walk through them at shallow depths so we can reach
            # sibling hub pages, but we don't keep them in the output.
            if looks_like_degree(cano, title):
                skipped_degree += 1
                links = extract_links(tree, cano)
                if d < depth:
                    for child in links:
                        if child not in visited:
                            queue.append((child, d + 1, cano))
                continue

            breadcrumbs = extract_breadcrumbs(tree)
            text, headings = extract_body(tree)
            links = extract_links(tree, cano)

            page = FacultyPage(
                url=cano,
                title=title,
                breadcrumbs=breadcrumbs,
                headings=headings,
                text=text,
                depth=d,
                kind=classify_hub(title),
                discovered_from=parent,
                children=links,
            )
            pages[cano] = page
            log.info(
                "[%d/%d depth=%d kind=%s] %s",
                len(pages), max_pages, d, page.kind, cano,
            )

            if d < depth:
                for child in links:
                    if child not in visited:
                        queue.append((child, d + 1, cano))

    log.info(
        "Crawl finished: kept %d hub pages, skipped %d degree-like pages",
        len(pages),
        skipped_degree,
    )
    return list(pages.values())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start", default=ROOT_URL, help="Seed URL for the crawl")
    ap.add_argument(
        "--depth",
        type=int,
        default=2,
        help="Maximum BFS depth (default 2 — index → faculty hub → department/centre)",
    )
    ap.add_argument(
        "--max-pages",
        type=int,
        default=300,
        help="Hard cap on hub pages kept (default 300)",
    )
    ap.add_argument(
        "--refresh",
        action="store_true",
        help="Bypass the on-disk HTML cache and re-fetch every page",
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

    pages = asyncio.run(
        crawl(
            start=args.start,
            depth=args.depth,
            max_pages=args.max_pages,
            refresh=args.refresh,
            rate=args.rate,
        )
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = [asdict(p) for p in pages]
    args.output.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    log.info("Wrote %d faculty pages to %s", len(payload), args.output)


if __name__ == "__main__":
    main()
