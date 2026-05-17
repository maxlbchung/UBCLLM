"""Chunk + embed UBC course/program JSON for the browser RAG runtime.

Inputs:
  ../scraper/output/courses.json
  ../scraper/output/faculties.json        — faculty/school/department hubs
  ../scraper/output/degree_programs.json  — every degree subtree (BA/MSc/PhD/cert)

Outputs:
  ../web/public/data/chunks.json    list[{id, kind, code, title, text, url}]
  ../web/public/data/embeddings.bin Float32Array, row-major, N x 384, L2-normalized

The model used here MUST stay compatible with what the browser uses
(`Xenova/all-MiniLM-L6-v2`). They share weights but ship under different
distributions; the underlying tokenizer + pooling are identical.
"""
from __future__ import annotations

import argparse
import json
import logging
import re
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).resolve().parent.parent
COURSES_JSON = ROOT / "scraper" / "output" / "courses.json"
# Faculty/school/department hub pages — the navigation layer of the
# calendar. Owned by scrape_faculties.py.
FACULTIES_JSON = ROOT / "scraper" / "output" / "faculties.json"
# Every degree program subtree (undergraduate, masters, doctoral, certificate)
# with rich per-page metadata: program, faculty, level, kind, referenced_courses.
# Owned by scrape_degree_programs.py. Wins over faculties.json on URL collision.
DEGREE_PROGRAMS_JSON = ROOT / "scraper" / "output" / "degree_programs.json"
# Hand-curated easter-egg Q&A pairs that ride alongside the scraped corpus.
# Lives next to the pipeline (not under scraper/output/) because nothing
# scrapes it — it's authored by hand. Each entry: {id?, title, text, url?}.
EASTER_EGGS_JSON = Path(__file__).resolve().parent / "easter-eggs.json"
OUTPUT_DIR = ROOT / "web" / "public" / "data"
CHUNKS_JSON = OUTPUT_DIR / "chunks.json"
EMBEDDINGS_BIN = OUTPUT_DIR / "embeddings.bin"

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
EMBED_DIM = 384
# ~200 tokens of body. Course chunks already sit around this; programs used to
# blow past it (median 1.4k chars, max 6.4k) because the binner here would
# treat any single oversized paragraph as its own un-split bin. That made the
# K=8 prompt for "general program" queries (astronomy, science) hit ~13 kB
# and trigger Windows TDR mid-prefill on the WebGPU backend. Capping here
# keeps the worst-case browser prompt bounded by construction and improves
# retrieval granularity (a long program page now becomes several chunks the
# embedder can match against more specifically).
TARGET_CHARS = 800

log = logging.getLogger("ubcllm.pipeline")


@dataclass
class Chunk:
    id: str
    kind: str            # "course" | "program" | "easter"
    code: str | None     # e.g. "CPSC 110" for course chunks; None for programs
    title: str
    text: str
    url: str


# ---------- chunk builders ----------

def course_chunk(c: dict) -> Chunk:
    parts = [f"{c['code']}: {c['title']}"]
    if c.get("credits"):
        parts.append(f"Credits: {c['credits']}")
    if c.get("description"):
        parts.append(c["description"])
    if c.get("prerequisites"):
        parts.append(f"Prerequisites: {c['prerequisites']}")
    if c.get("corequisites"):
        parts.append(f"Corequisites: {c['corequisites']}")
    if c.get("equivalency"):
        parts.append(f"Equivalency: {c['equivalency']}")
    if c.get("recommended"):
        parts.append(f"Recommended: {c['recommended']}")
    return Chunk(
        id=f"course:{c['subject']}_{c['number']}",
        kind="course",
        code=c["code"],
        title=c["title"],
        text="\n".join(parts),
        url=c["url"],
    )


_SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[.!?])\s+")
_HEADING_RE = re.compile(r"^(#{2,4})\s+(.+)$")
# Umbrella headings act as parent context for the headings that follow.
# The UBC calendar template uses h4 for everything on degree pages, so a
# page like Data Science has "Specializations" → "Major: Data Science
# (DSCI)" → "Learning Outcomes" / "Specialization Requirements" /
# "Co-op Option" → "Minor in Data Science" → "Lower-Level Requirements"
# / "Upper-Level Requirements" all rendered as flat h4s. Without an
# umbrella signal, the chunker would tag the major's "Specialization
# Requirements" section identically to the minor's "Upper-Level
# Requirements" section. The pattern below catches the common umbrella
# shapes: "Specializations", "Major: …", "Minor in …", "Bachelor of …",
# "Master of …", etc. The most recent umbrella becomes the chunk
# section path's first entry; the section's own heading is appended
# after it.
_UMBRELLA_RE = re.compile(
    r"^("
    r"Specializations\s*$|"
    r"Major\s*[:]|Major\s+in\s|"
    r"Minor\s*[:]|Minor\s+in\s|"
    r"Honours\s*[:]|Honours\s+in\s|"
    r"Combined\s+Major|Dual\s+Degree|"
    r"Bachelor of\s|Master of\s|Doctor of\s|"
    r"Certificate in\s|Diploma in\s"
    r")",
    re.IGNORECASE,
)
# Sections shorter than this stay as a single chunk. Only when a single
# section's body exceeds this threshold do we bin-pack within it. Set
# above TARGET_CHARS so a section a bit larger than the typical bin still
# stays whole (a "Learning Outcomes" list shouldn't be sliced in half just
# because it overshoots by 200 chars). The old greedy bin-packing crossed
# section boundaries; the new behaviour respects header structure first
# and only falls back to bin-packing inside oversized sections.
SECTION_SPLIT_THRESHOLD = TARGET_CHARS * 2  # 1600 chars


def _split_long(text: str, max_chars: int) -> list[str]:
    """Split a paragraph that's longer than max_chars into pieces ≤ max_chars.

    Tries sentence boundaries first; if a single sentence is still too long
    (rare — long bullet lists with no terminal punctuation), falls back to a
    hard char-window split so we never emit an oversized piece.
    """
    if len(text) <= max_chars:
        return [text]
    sentences = _SENTENCE_BOUNDARY_RE.split(text)
    out: list[str] = []
    cur = ""
    for s in sentences:
        if len(s) > max_chars:
            if cur:
                out.append(cur)
                cur = ""
            for i in range(0, len(s), max_chars):
                out.append(s[i:i + max_chars])
            continue
        candidate = f"{cur} {s}".strip() if cur else s
        if len(candidate) > max_chars:
            out.append(cur)
            cur = s
        else:
            cur = candidate
    if cur:
        out.append(cur)
    return out


def _split_into_sections(text: str) -> list[tuple[list[str], str]]:
    """Walk heading-marked text and emit `[(heading_path, content)]`.

    Heading markers come from the scrapers' extract_body (`##` h2,
    `###` h3, `####` h4). Section path is built from:
      1. The hierarchical heading stack — an h4 keeps the active h2/h3
         in the path because they're its structural ancestors.
      2. The most recent "umbrella" heading at the same level (matched
         against _UMBRELLA_RE). UBC degree pages render "Specializations"
         / "Major: X" / "Minor in X" as flat h4s alongside their own
         subsections; without the umbrella signal, the major's
         "Specialization Requirements" and the minor's "Lower-Level
         Requirements" would look indistinguishable to MiniLM. We
         capture the umbrella and prepend it to the path of any
         subsequent same-level heading.
    Text before any heading is emitted with an empty path (the intro).
    """
    sections: list[tuple[list[str], str]] = []
    heading_stack: list[tuple[int, str]] = []  # (level, text)
    umbrella_at_level: dict[int, str] = {}
    content_lines: list[str] = []

    def current_path() -> list[str]:
        path = [h[1] for h in heading_stack[:-1]]
        if heading_stack:
            level, heading = heading_stack[-1]
            umb = umbrella_at_level.get(level)
            if umb and umb != heading and umb not in path:
                path.append(umb)
            path.append(heading)
        return path

    def flush() -> None:
        body = "\n".join(content_lines).strip()
        if body:
            sections.append((current_path(), body))
        content_lines.clear()

    for line in text.split("\n"):
        m = _HEADING_RE.match(line)
        if m:
            level = len(m.group(1))
            heading_text = m.group(2).strip()
            flush()
            # Pop hierarchical entries at same-or-deeper level. Drop
            # umbrellas at strictly deeper levels — they've gone out of
            # scope when their ancestor changes — but keep same-level
            # umbrellas so an active "Major: X" survives past its own
            # sibling subsections.
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            for lvl in list(umbrella_at_level):
                if lvl > level:
                    del umbrella_at_level[lvl]
            heading_stack.append((level, heading_text))
            if _UMBRELLA_RE.match(heading_text):
                umbrella_at_level[level] = heading_text
        else:
            content_lines.append(line)
    flush()
    return sections


def _bin_pack(content: str, target_chars: int) -> list[str]:
    """Greedy bin-pack content into ≤ target_chars bins, splitting any
    single oversized paragraph on sentence boundaries first. Same shape as
    the old in-line bin packer in degree_program_chunks; pulled out so it
    can be reused inside section-aware chunking when a section is too big
    to keep whole."""
    paragraphs: list[str] = []
    for pg in content.split("\n"):
        pg = pg.strip()
        if pg:
            paragraphs.extend(_split_long(pg, target_chars))
    bins: list[list[str]] = []
    cur: list[str] = []
    cur_len = 0
    for pg in paragraphs:
        if cur and cur_len + len(pg) > target_chars:
            bins.append(cur)
            cur = [pg]
            cur_len = len(pg)
        else:
            cur.append(pg)
            cur_len += len(pg) + 1
    if cur:
        bins.append(cur)
    return ["\n".join(b) for b in bins]


def _section_aware_bodies(text: str) -> list[tuple[str, str]]:
    """Convert heading-marked text into `[(section_label, body)]` chunks
    ready for embedding. section_label is `" > ".join(heading_path)` or
    empty string for the intro. body is kept whole when its length is at
    or below SECTION_SPLIT_THRESHOLD; oversized sections fall through to
    the greedy bin-packer with TARGET_CHARS. Repeats the section_label
    across all bins from one section so MiniLM sees the same section
    context on every slice."""
    out: list[tuple[str, str]] = []
    for path, content in _split_into_sections(text):
        label = " > ".join(path)
        if len(content) <= SECTION_SPLIT_THRESHOLD:
            out.append((label, content))
            continue
        for body in _bin_pack(content, TARGET_CHARS):
            out.append((label, body))
    return out


def easter_chunk(e: dict) -> Chunk:
    """Hand-curated Q&A entry. Embedded text is "title\\n\\nbody" so a query
    that paraphrases the title lands close in MiniLM space and the chunk gets
    retrieved on its own merits — there is *no* score boost for this kind in
    retrieve.ts, only the semantic match.
    """
    title = e["title"]
    body = e.get("text") or ""
    fallback_id = title.lower().replace("?", "").replace(" ", "-").strip("-")
    eid = e.get("id") or fallback_id
    return Chunk(
        id=f"easter:{eid}",
        kind="easter",
        code=None,
        title=title,
        text=f"{title}\n\n{body}" if body else title,
        url=e.get("url", ""),
    )


def degree_program_chunks(p: dict) -> list[Chunk]:
    """Chunk one degree-program page (undergraduate, masters, doctoral, cert).

    Chunks are section-aware: the scraper's extract_body emits `##/###/####`
    markers around each heading on the page, and _section_aware_bodies
    above slices the body at those markers so each chunk is "one section
    of one page", not "a greedy paragraph bin that crosses heading
    boundaries". Each chunk's text is prefixed with the page metadata
    (program / faculty / level / page-kind / breadcrumb) plus the
    in-page section path (e.g. "Section: Major: Data Science (DSCI) >
    Specialization Requirements") so the embedder and the LLM both see
    which sub-section the chunk came from. This is what lets a query
    like "data science MAJOR specialization requirements" land closer
    to the major's section than to the minor's similar-looking content.

    Stays kind="program" on the Chunk so the browser's retrieval
    heuristics (program-title boost, buddy boost in retrieve.ts) keep
    working unchanged. Distinguished from generic program chunks via the
    `degree:` id prefix.
    """
    text = (p.get("text") or "").strip()
    if not text:
        return []

    title = p.get("title") or ""
    program = p.get("program") or ""
    faculty = p.get("faculty") or ""
    level = p.get("level") or ""
    page_kind = p.get("kind") or ""
    breadcrumbs = p.get("breadcrumbs") or []
    crumb = " > ".join(breadcrumbs[1:]) if len(breadcrumbs) > 1 else ""
    base_id = (p["url"].rstrip("/").rsplit("/", 1)[-1] or "root").lower()

    meta_bits: list[str] = []
    if program:
        meta_bits.append(f"Program: {program}")
    if faculty:
        meta_bits.append(f"Faculty: {faculty}")
    if level:
        meta_bits.append(f"Level: {level}")
    # Renamed from "Section: <kind>" to "Page: <kind>" because the
    # per-chunk "Section: …" label below now carries the actual in-page
    # heading path. Keeping both lines without renaming this one would
    # have two competing "Section:" lines per chunk.
    if page_kind and page_kind != "other":
        meta_bits.append(f"Page: {page_kind.replace('_', ' ')}")
    meta_line = " · ".join(meta_bits)

    base_prefix_parts = [title]
    if meta_line:
        base_prefix_parts.append(meta_line)
    if crumb:
        base_prefix_parts.append(crumb)
    base_prefix = "\n".join(s for s in base_prefix_parts if s)

    out: list[Chunk] = []
    for i, (section_label, body) in enumerate(_section_aware_bodies(text)):
        if section_label:
            prefix = f"{base_prefix}\nSection: {section_label}" if base_prefix else f"Section: {section_label}"
        else:
            prefix = base_prefix
        full = f"{prefix}\n\n{body}" if prefix else body
        out.append(Chunk(
            id=f"degree:{base_id}:{i}",
            kind="program",
            code=None,
            title=title,
            text=full,
            url=p["url"],
        ))
    return out


def program_chunks(p: dict) -> list[Chunk]:
    """Chunk one faculty/school/department hub page from faculties.json.

    Section-aware via _section_aware_bodies — same approach as
    degree_program_chunks but without the degree-specific metadata
    (program / faculty / level / page-kind). The chunker prepends the
    page title + breadcrumb + in-page section path to each chunk so the
    embedder sees structural context."""
    text = (p.get("text") or "").strip()
    if not text:
        return []

    title = p.get("title") or ""
    breadcrumbs = p.get("breadcrumbs") or []
    crumb = " > ".join(breadcrumbs[1:]) if len(breadcrumbs) > 1 else ""
    base_id = (p["url"].rstrip("/").rsplit("/", 1)[-1] or "root").lower()

    base_prefix = title
    if crumb:
        base_prefix = f"{title}\n{crumb}"

    out: list[Chunk] = []
    for i, (section_label, body) in enumerate(_section_aware_bodies(text)):
        if section_label:
            prefix = f"{base_prefix}\nSection: {section_label}" if base_prefix else f"Section: {section_label}"
        else:
            prefix = base_prefix
        full = f"{prefix}\n\n{body}" if prefix else body
        out.append(Chunk(
            id=f"program:{base_id}:{i}",
            kind="program",
            code=None,
            title=title,
            text=full,
            url=p["url"],
        ))
    return out


# ---------- main ----------

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--batch-size", type=int, default=64)
    ap.add_argument("--limit", type=int, help="Cap number of chunks (debug)")
    ap.add_argument("--no-courses", action="store_true")
    ap.add_argument("--no-programs", action="store_true")
    ap.add_argument("--no-easter-eggs", action="store_true")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    chunks: list[Chunk] = []

    if not args.no_courses:
        log.info("Loading %s", COURSES_JSON)
        courses = json.loads(COURSES_JSON.read_text(encoding="utf-8"))
        log.info("  %d courses", len(courses))
        for c in courses:
            chunks.append(course_chunk(c))

    if not args.no_programs:
        # Load degree-program pages first; they have richer per-page metadata
        # (program/faculty/level/kind/referenced_courses) and supersede any
        # same-URL entry in the faculties hub set.
        degree_urls: set[str] = set()
        if DEGREE_PROGRAMS_JSON.exists():
            log.info("Loading %s", DEGREE_PROGRAMS_JSON)
            dp = json.loads(
                DEGREE_PROGRAMS_JSON.read_text(encoding="utf-8")
            )
            log.info("  %d degree program pages", len(dp))
            for p in dp:
                chunks.extend(degree_program_chunks(p))
                degree_urls.add(p["url"])
        else:
            log.info(
                "Skipping %s (not found — run scrape_degree_programs.py)",
                DEGREE_PROGRAMS_JSON,
            )

        if FACULTIES_JSON.exists():
            log.info("Loading %s", FACULTIES_JSON)
            faculties = json.loads(FACULTIES_JSON.read_text(encoding="utf-8"))
            kept = 0
            for p in faculties:
                if p.get("url") in degree_urls:
                    continue
                chunks.extend(program_chunks(p))
                kept += 1
            log.info(
                "  %d faculty hub pages (%d skipped as already covered by degree set)",
                kept,
                len(faculties) - kept,
            )
        else:
            log.info(
                "Skipping %s (not found — run scrape_faculties.py)",
                FACULTIES_JSON,
            )

    if not args.no_easter_eggs and EASTER_EGGS_JSON.exists():
        log.info("Loading %s", EASTER_EGGS_JSON)
        eggs = json.loads(EASTER_EGGS_JSON.read_text(encoding="utf-8"))
        log.info("  %d easter eggs", len(eggs))
        for e in eggs:
            chunks.append(easter_chunk(e))

    seen: set[str] = set()
    deduped: list[Chunk] = []
    for ch in chunks:
        if ch.id in seen:
            continue
        seen.add(ch.id)
        deduped.append(ch)
    chunks = deduped

    if args.limit:
        chunks = chunks[: args.limit]

    n_course = sum(1 for c in chunks if c.kind == "course")
    n_program = sum(1 for c in chunks if c.kind == "program")
    n_easter = sum(1 for c in chunks if c.kind == "easter")
    log.info(
        "Total chunks: %d (%d course, %d program, %d easter)",
        len(chunks),
        n_course,
        n_program,
        n_easter,
    )

    log.info("Loading embedding model %s", MODEL_NAME)
    model = SentenceTransformer(MODEL_NAME)

    # Embed easter chunks from their TITLE alone, not title+body. The body
    # is the curated answer (often long-form prose), and concatenating it
    # into the embedding dilutes the title's semantic signature — e.g.
    # "What is the Old tale?" with a 60-word answer body lands at cosine
    # 0.55 against the verbatim query "what is the old tale?", below the
    # easter retrieval floor. Embedding the title only puts that same
    # query at cosine ~1.0, so on-topic queries actually fire the easter.
    # The full text (title+body) still goes into chunks.json for the LLM
    # to see at generation time; only the embedding source changes.
    texts = [c.title if c.kind == "easter" else c.text for c in chunks]
    log.info("Embedding %d chunks (batch=%d)…", len(texts), args.batch_size)
    embeddings = model.encode(
        texts,
        batch_size=args.batch_size,
        show_progress_bar=True,
        convert_to_numpy=True,
        normalize_embeddings=True,  # so cosine == dot product
    )
    embeddings = embeddings.astype(np.float32, copy=False)
    if embeddings.shape != (len(texts), EMBED_DIM):
        raise RuntimeError(
            f"unexpected embedding shape {embeddings.shape}, "
            f"expected ({len(texts)}, {EMBED_DIM})"
        )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # chunks.json: pretty-print disabled to keep payload small. The browser
    # parses this once at load time.
    payload = [asdict(c) for c in chunks]
    CHUNKS_JSON.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    log.info(
        "Wrote chunks.json: %d entries, %.1f MB",
        len(payload),
        CHUNKS_JSON.stat().st_size / 1024 / 1024,
    )

    embeddings.tofile(EMBEDDINGS_BIN)
    log.info(
        "Wrote embeddings.bin: shape %s, %.1f MB",
        embeddings.shape,
        EMBEDDINGS_BIN.stat().st_size / 1024 / 1024,
    )


if __name__ == "__main__":
    main()
