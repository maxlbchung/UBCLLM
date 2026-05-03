"""Crawl UBC Vancouver faculty / program calendar pages into JSON.

The root index lives at:
    https://vancouver.calendar.ubc.ca/faculties-colleges-and-schools

Faculty pages are mostly navigation; the leaf pages (degree requirements,
admission, etc.) carry the text we want. Internal table-of-contents entries
often link via opaque /node/N IDs that redirect to canonical paths under
/faculties-colleges-and-schools/, so we follow both forms.

Output: scraper/output/programs.json — one record per page, with title,
breadcrumb trail, and plain-text body.

Usage:
    uv run scrape_programs.py                # default depth 4, cap 800 pages
    uv run scrape_programs.py --depth 2
    uv run scrape_programs.py --max-pages 50 # debug
    uv run scrape_programs.py --refresh
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
    OUTPUT_DIR,
    RateLimitedClient,
    configure_logging,
    log,
    make_async_client,
)

ROOT_URL = f"{BASE_URL}/faculties-colleges-and-schools"
OUTPUT_FILE = OUTPUT_DIR / "programs.json"

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


@dataclass
class ProgramPage:
    url: str
    title: str
    breadcrumbs: list[str]
    headings: list[str]
    text: str
    depth: int
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


def extract_body(tree: HTMLParser) -> tuple[str, list[str]]:
    root = _content_root(tree)
    _strip_chrome(root)
    headings: list[str] = []
    for h in root.css("h2, h3, h4"):
        t = h.text(strip=True)
        if t:
            headings.append(re.sub(r"\s+", " ", t))
    blocks: list[str] = []
    for el in root.css("p, li, h2, h3, h4"):
        t = el.text(separator=" ", strip=True)
        if t:
            blocks.append(re.sub(r"\s+", " ", t))
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
) -> list[ProgramPage]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    pages: dict[str, ProgramPage] = {}

    async with make_async_client() as raw_client:
        client = RateLimitedClient(raw_client, min_interval=rate)

        queue: deque[tuple[str, int, str | None]] = deque([(normalize(start), 0, None)])
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
            # Treat canonical and crawl URL as the same page, but key by canonical.
            if cano != url:
                visited.add(cano)
            if cano in pages:
                continue

            title = extract_title(tree)
            breadcrumbs = extract_breadcrumbs(tree)
            text, headings = extract_body(tree)
            links = extract_links(tree, cano)

            page = ProgramPage(
                url=cano,
                title=title,
                breadcrumbs=breadcrumbs,
                headings=headings,
                text=text,
                depth=d,
                discovered_from=parent,
                children=links,
            )
            pages[cano] = page
            log.info(
                "[%d/%d depth=%d] %s -> %d links, %d chars",
                len(pages), max_pages, d, cano, len(links), len(text),
            )

            if d < depth:
                for child in links:
                    if child not in visited:
                        queue.append((child, d + 1, cano))

    return list(pages.values())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start", default=ROOT_URL, help="Seed URL for the crawl")
    ap.add_argument("--depth", type=int, default=4, help="Maximum BFS depth (default 4)")
    ap.add_argument(
        "--max-pages",
        type=int,
        default=800,
        help="Hard cap on pages fetched (default 800)",
    )
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
    args.output.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    log.info("Wrote %d program pages to %s", len(payload), args.output)


if __name__ == "__main__":
    main()
