"""Crawl every UBC Vancouver degree program subtree — undergraduate, masters,
doctoral, and certificate/diploma — into a single enriched JSON file.

This scraper owns the *degree* layer of the calendar: every page that lives
inside a specific degree subtree (Bachelor of Science → its specializations,
majors, minors, honours, advising; Master of X → its requirements, courses,
etc.). The companion scraper `scrape_faculties.py` owns the navigation
layer (faculty/school/department overviews) — the two outputs deliberately
don't overlap.

For every page it emits:

    {url, title, breadcrumbs, headings, text, depth, discovered_from,
     program, faculty, level, kind, referenced_courses, children}

- `program`: the specific degree this page lives under (e.g. "Bachelor of
   Science", "Master of Science", "Doctor of Philosophy in Physics").
- `faculty`: derived from the breadcrumb (e.g. "The Faculty of Science").
- `level`: coarse degree level — `undergraduate` / `masters` / `doctoral` /
   `certificate`.
- `kind`: section type within the subtree (degree_overview, degree_requirements,
   specialization, major, minor, honours, admission, regulations, curriculum,
   advising, coop, dual_degree, other).
- `referenced_courses`: every UBC course code mentioned in the body.

Seed discovery is self-contained: a shallow BFS over the faculties subtree
collects every page whose title + slug match the degree heuristics below.
That makes this script runnable on its own without depending on
`scrape_faculties.py`.

Output: scraper/output/degree_programs.json

Usage:
    uv run scrape_degree_programs.py
    uv run scrape_degree_programs.py --max-pages-per-program 200
    uv run scrape_degree_programs.py --only "Bachelor of Science"
    uv run scrape_degree_programs.py --only "Master of"
    uv run scrape_degree_programs.py --refresh
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
OUTPUT_FILE = OUTPUT_DIR / "degree_programs.json"

NODE_PATH_RE = re.compile(r"^/node/\d+/?$")

# Degree-title patterns. UBC mixes long forms ("Bachelor of Science") with
# abbreviation forms ("B.A.Sc. in …", "M.Sc.", "Ph.D."), so we accept both.
# Order isn't important; we use this as a single-shot match against the
# leading run of the title.
DEGREE_TITLE_RE = re.compile(
    r"^("
    # Spelled-out long forms
    r"Bachelor of\b|UBC Bachelor of\b|"
    r"Master of\b|UBC Master of\b|"
    r"Doctor of\b|"
    r"(?:Graduate|Undergraduate) Certificate\b|"
    r"Certificate in\b|Diploma in\b|"
    # Abbreviation forms with dotted letters: B.A., B.Sc., B.A.Sc., M.A.,
    # M.Sc., M.A.Sc., M.Eng., M.Ed., M.Arch., Ph.D., D.M.A., etc.
    r"B\.[A-Z]+(?:\.[A-Z]+)*\.|"
    r"M\.[A-Z]+(?:\.[A-Z]+)*\.|"
    r"D\.[A-Z]+(?:\.[A-Z]+)*\.|"
    r"Ph\.?\s?D\.?|"
    # Compact abbreviations used in some titles
    r"MBA\b|MFA\b|MEd\b|MEng\b|MASc\b|MSc\b|MA\b|MArch\b"
    r")",
    re.IGNORECASE,
)

# Slug prefixes for degree-root pages. The discovery pass only nominates a
# page as a seed if its URL slug matches one of these — keeps us from
# accidentally adopting a child page (e.g. "honours" under a Bachelor) as a
# new seed.
DEGREE_SLUG_PREFIXES = (
    # Bachelor
    "bachelor-", "basc-", "bsc-", "bsf-", "bils-", "b-i-l-s", "buf-", "b-u-f",
    # Master
    "master-", "masters-", "mba-", "mfa-", "med-", "meng-", "masc-",
    "ma-", "msc-", "m-arch", "m-ed", "m-eng", "m-sc", "m-a", "m-asc",
    # Doctoral
    "doctor-", "doctoral-", "phd-", "ph-d", "d-m-a",
    # Certificate / diploma
    "graduate-certificate-", "undergraduate-certificate-",
    "certificate-", "diploma-",
)

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

# Course-code matcher — same shape as the courses.json subject regex.
COURSE_CODE_RE = re.compile(
    r"\b([A-Z]{2,5}(?:_V)?)\s?(\d{3}[A-Z]?)\b"
)

# Section / kind classification (slug + title haystack). Order matters:
# most specific first.
KIND_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"degree-requirements?\b|graduation-requirements?\b"), "degree_requirements"),
    (re.compile(r"\bhonours\b"), "honours"),
    (re.compile(r"\bminor[s]?\b"), "minor"),
    (re.compile(r"\bmajor[s]?\b"), "major"),
    (re.compile(r"\bspecializ(ation|ed)\b"), "specialization"),
    (re.compile(r"\b(combined|dual)[-_]?degree\b"), "dual_degree"),
    (re.compile(r"co-?operative|co-?op"), "coop"),
    (re.compile(r"\badmission|transfer\b"), "admission"),
    (re.compile(r"academic-regulations|general-academic|promotion|standing"), "regulations"),
    (re.compile(r"curriculum|first-year|year-one|second-year"), "curriculum"),
    (re.compile(r"advising|academic-information"), "advising"),
    (re.compile(r"thesis|comprehensive-exam|qualifying-exam|candidacy"), "regulations"),
]

# Level classification driven by title prefix. The first match wins.
LEVEL_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^(bachelor|ubc bachelor|b\.[a-z])", re.IGNORECASE), "undergraduate"),
    (re.compile(r"^(undergraduate certificate)", re.IGNORECASE), "undergraduate"),
    (re.compile(r"^(master|ubc master|m\.[a-z]|mba|mfa|med|meng|masc|msc|ma|march)\b", re.IGNORECASE), "masters"),
    (re.compile(r"^(graduate certificate)", re.IGNORECASE), "masters"),
    (re.compile(r"^(doctor|ph\.?\s?d|d\.[a-z])", re.IGNORECASE), "doctoral"),
    (re.compile(r"^(certificate|diploma) ", re.IGNORECASE), "certificate"),
]


@dataclass
class DegreePage:
    url: str
    title: str
    breadcrumbs: list[str]
    headings: list[str]
    text: str
    depth: int
    discovered_from: str | None
    program: str
    faculty: str
    level: str
    kind: str
    referenced_courses: list[str]
    children: list[str] = field(default_factory=list)


@dataclass
class DegreeSeed:
    url: str
    title: str
    root_path: str  # url path used as subtree boundary
    level: str


# ---------- URL helpers ----------

def normalize(url: str) -> str:
    p = urlparse(url)
    netloc = p.netloc or urlparse(BASE_URL).netloc
    path = p.path.rstrip("/") or "/"
    return f"{p.scheme or 'https'}://{netloc}{path}"


def is_ubc_host(url: str) -> bool:
    p = urlparse(url)
    return not p.netloc or p.netloc == urlparse(BASE_URL).netloc


def under_faculties(url: str) -> bool:
    if not is_ubc_host(url):
        return False
    path = urlparse(url).path
    if NODE_PATH_RE.match(path):
        return True
    return path.startswith("/faculties-colleges-and-schools")


def in_subtree(url: str, root_path: str) -> bool:
    if not is_ubc_host(url):
        return False
    path = urlparse(url).path.rstrip("/") or "/"
    return path == root_path or path.startswith(root_path + "/")


def matches_degree(url: str, title: str) -> tuple[bool, str]:
    """Return (is_degree_root, level) for a candidate URL + title.

    Both the slug prefix and the title pattern must match — a slug like
    "minor-statistics" is not a degree root even though "minor" is part of
    the degree-page vocabulary.
    """
    slug = urlparse(url).path.rsplit("/", 1)[-1].lower()
    if not any(slug.startswith(pre) for pre in DEGREE_SLUG_PREFIXES):
        return False, ""
    if not title or not DEGREE_TITLE_RE.match(title):
        return False, ""
    for pat, lvl in LEVEL_RULES:
        if pat.match(title):
            return True, lvl
    return True, "other"


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
    for el in root.css("p, li, h2, h3, h4, td"):
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
        if full in seen:
            continue
        seen.add(full)
        out.append(full)
    return out


def extract_course_codes(text: str) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for subj, num in COURSE_CODE_RE.findall(text):
        subj_clean = subj.removesuffix("_V")
        code = f"{subj_clean} {num}"
        if code in seen:
            continue
        # Cheap noise filter: real UBC subjects are 3-5 letters.
        if len(subj_clean) < 3:
            continue
        seen.add(code)
        out.append(code)
    return out


def classify_kind(url: str, title: str) -> str:
    slug = urlparse(url).path.rsplit("/", 1)[-1].lower()
    is_degree, _ = matches_degree(url, title)
    if is_degree:
        return "degree_overview"
    haystack = f"{slug} {title.lower()}"
    for pat, kind in KIND_RULES:
        if pat.search(haystack):
            return kind
    return "other"


def derive_faculty(breadcrumbs: list[str], url: str) -> str:
    # Breadcrumb shape is typically:
    #   Home > Faculties, Colleges, and Schools > Faculty of X > Bachelor of Y > ...
    for crumb in breadcrumbs[2:]:
        if any(word in crumb for word in ("Faculty", "School", "College", "Vantage")):
            return crumb
    parts = urlparse(url).path.strip("/").split("/")
    if len(parts) >= 2 and parts[0] == "faculties-colleges-and-schools":
        return parts[1].replace("-", " ").title()
    return ""


# ---------- Seed discovery ----------

async def discover_seeds(
    *,
    client: RateLimitedClient,
    max_depth: int,
    max_pages: int,
    refresh: bool,
    only: str | None,
) -> list[DegreeSeed]:
    """Shallow BFS over the faculties subtree to find degree-root pages.

    Goes only as deep as needed to enumerate every "Bachelor of …" /
    "Master of …" / "Doctor of …" / certificate landing page. Doesn't
    descend into a seed once found (those subtrees are handled in the
    main exhaustive crawl). All pages fetched here populate the on-disk
    cache, so the main crawl gets a head start.
    """
    seeds: dict[str, DegreeSeed] = {}
    visited: set[str] = set()
    queue: deque[tuple[str, int]] = deque([(normalize(ROOT_URL), 0)])
    fetched = 0

    while queue and fetched < max_pages:
        url, d = queue.popleft()
        if url in visited:
            continue
        visited.add(url)
        if not under_faculties(url):
            continue

        try:
            html = await client.get_html(url, force=refresh)
        except Exception as exc:  # noqa: BLE001
            log.error("seed discovery FAILED %s: %s", url, exc)
            continue
        fetched += 1

        tree = HTMLParser(html)
        cano = canonical_url(tree, url)
        if cano != url:
            visited.add(cano)
        title = extract_title(tree)

        is_degree, level = matches_degree(cano, title)
        if is_degree and cano not in seeds:
            if only and only.lower() not in title.lower():
                pass  # skip non-matching
            else:
                root_path = urlparse(cano).path.rstrip("/") or "/"
                seeds[cano] = DegreeSeed(
                    url=cano,
                    title=title,
                    root_path=root_path,
                    level=level,
                )
                log.info("  + seed [%s] %s", level, title)
            # Don't descend into a seed during discovery — the main crawl
            # owns that subtree. Other sibling degrees still get reached
            # via the rest of the queue.
            continue

        if d < max_depth:
            for child in extract_links(tree, cano):
                if not under_faculties(child):
                    continue
                if child not in visited:
                    queue.append((child, d + 1))

    # Process deepest seeds first so a specific degree page claims its
    # subtree's pages before a shallower hub seed gets to them.
    out = sorted(
        seeds.values(),
        key=lambda s: (-len(urlparse(s.url).path.split("/")), s.title),
    )
    log.info("Discovered %d degree seed pages (%d pages fetched)", len(out), fetched)
    return out


# ---------- Crawl ----------

async def crawl_subtree(
    *,
    client: RateLimitedClient,
    seed: DegreeSeed,
    max_pages: int,
    refresh: bool,
) -> list[DegreePage]:
    pages: dict[str, DegreePage] = {}
    queue: deque[tuple[str, int, str | None]] = deque(
        [(normalize(seed.url), 0, None)]
    )
    visited: set[str] = set()

    while queue and len(pages) < max_pages:
        url, d, parent = queue.popleft()
        if url in visited:
            continue
        visited.add(url)

        is_node = NODE_PATH_RE.match(urlparse(url).path) is not None
        if not is_node and not in_subtree(url, seed.root_path):
            continue

        try:
            html = await client.get_html(url, force=refresh)
        except Exception as exc:  # noqa: BLE001
            log.error("FAILED %s: %s", url, exc)
            continue

        tree = HTMLParser(html)
        cano = canonical_url(tree, url)
        if cano != url:
            visited.add(cano)
        if not in_subtree(cano, seed.root_path):
            continue
        if cano in pages:
            continue

        title = extract_title(tree)
        breadcrumbs = extract_breadcrumbs(tree)
        text, headings = extract_body(tree)
        raw_links = extract_links(tree, cano)

        in_links: list[str] = []
        for c in raw_links:
            if not is_ubc_host(c):
                continue
            c_path = urlparse(c).path
            if NODE_PATH_RE.match(c_path) or in_subtree(c, seed.root_path):
                in_links.append(c)

        page = DegreePage(
            url=cano,
            title=title,
            breadcrumbs=breadcrumbs,
            headings=headings,
            text=text,
            depth=d,
            discovered_from=parent,
            program=seed.title,
            faculty=derive_faculty(breadcrumbs, cano),
            level=seed.level,
            kind=classify_kind(cano, title),
            referenced_courses=extract_course_codes(text),
            children=in_links,
        )
        pages[cano] = page
        log.info(
            "[%s] %d pages, depth=%d, courses=%d %s",
            seed.title,
            len(pages),
            d,
            len(page.referenced_courses),
            cano,
        )

        for child in in_links:
            if child not in visited:
                queue.append((child, d + 1, cano))

    return list(pages.values())


async def crawl_all(
    *,
    discover_depth: int,
    discover_max: int,
    max_pages_per_program: int,
    refresh: bool,
    rate: float,
    only: str | None,
) -> list[DegreePage]:
    all_pages: dict[str, DegreePage] = {}
    async with make_async_client() as raw_client:
        client = RateLimitedClient(raw_client, min_interval=rate)

        log.info("=== Discovering degree seeds (BFS, depth=%d) ===", discover_depth)
        seeds = await discover_seeds(
            client=client,
            max_depth=discover_depth,
            max_pages=discover_max,
            refresh=refresh,
            only=only,
        )
        if not seeds:
            log.error("No degree seeds found. Check connectivity or relax --only.")
            return []

        for seed in seeds:
            log.info("=== %s [%s] (%s) ===", seed.title, seed.level, seed.url)
            sub_pages = await crawl_subtree(
                client=client,
                seed=seed,
                max_pages=max_pages_per_program,
                refresh=refresh,
            )
            # Cross-seed dedupe by canonical URL. Seeds are sorted deepest
            # first, so a specific-degree subtree wins over a shallower hub.
            for p in sub_pages:
                if p.url not in all_pages:
                    all_pages[p.url] = p
    return list(all_pages.values())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--max-pages-per-program",
        type=int,
        default=400,
        help="Cap on pages crawled per degree subtree (default 400)",
    )
    ap.add_argument(
        "--discover-depth",
        type=int,
        default=4,
        help="Max BFS depth when discovering degree seed pages (default 4)",
    )
    ap.add_argument(
        "--discover-max",
        type=int,
        default=1500,
        help="Max pages fetched during seed discovery (default 1500)",
    )
    ap.add_argument(
        "--only",
        help="Only keep seeds whose title contains this substring (e.g. 'Bachelor of', 'Master of')",
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
        crawl_all(
            discover_depth=args.discover_depth,
            discover_max=args.discover_max,
            max_pages_per_program=args.max_pages_per_program,
            refresh=args.refresh,
            rate=args.rate,
            only=args.only,
        )
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = [asdict(p) for p in pages]
    args.output.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # Stats summary for visibility.
    from collections import Counter
    by_level = Counter(p["level"] for p in payload)
    by_kind = Counter(p["kind"] for p in payload)
    log.info(
        "Wrote %d degree program pages to %s",
        len(payload),
        args.output,
    )
    log.info("  by level: %s", dict(by_level.most_common()))
    log.info("  by kind:  %s", dict(by_kind.most_common()))


if __name__ == "__main__":
    main()
