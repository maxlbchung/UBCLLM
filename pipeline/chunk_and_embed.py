"""Chunk + embed UBC course/program JSON for the browser RAG runtime.

Inputs:
  ../scraper/output/courses.json
  ../scraper/output/programs.json

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
PROGRAMS_JSON = ROOT / "scraper" / "output" / "programs.json"
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


def program_chunks(p: dict) -> list[Chunk]:
    text = (p.get("text") or "").strip()
    if not text:
        return []
    # Split first, then bin. Without the per-paragraph split, a single
    # oversized paragraph becomes its own un-split bin (the old bug — a 6.4k-
    # char paragraph would ride straight into chunks.json untouched).
    paragraphs: list[str] = []
    for pg in text.split("\n"):
        pg = pg.strip()
        if pg:
            paragraphs.extend(_split_long(pg, TARGET_CHARS))

    bins: list[list[str]] = []
    cur: list[str] = []
    cur_len = 0
    for pg in paragraphs:
        if cur and cur_len + len(pg) > TARGET_CHARS:
            bins.append(cur)
            cur = [pg]
            cur_len = len(pg)
        else:
            cur.append(pg)
            cur_len += len(pg) + 1
    if cur:
        bins.append(cur)

    title = p.get("title") or ""
    breadcrumbs = p.get("breadcrumbs") or []
    crumb = " > ".join(breadcrumbs[1:]) if len(breadcrumbs) > 1 else ""
    base_id = (p["url"].rstrip("/").rsplit("/", 1)[-1] or "root").lower()

    out: list[Chunk] = []
    for i, pg_lines in enumerate(bins):
        prefix = title
        if crumb:
            prefix = f"{title}\n{crumb}"
        body = "\n".join(pg_lines)
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
        log.info("Loading %s", PROGRAMS_JSON)
        programs = json.loads(PROGRAMS_JSON.read_text(encoding="utf-8"))
        log.info("  %d program pages", len(programs))
        for p in programs:
            chunks.extend(program_chunks(p))

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
