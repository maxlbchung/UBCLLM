"""Mirror web/src/lib/retrieve.ts topK for a single query and print the
chunks the runtime would actually feed to the LLM. Helps debug why a query
lands on weird sources or empty context.

Usage:
  uv run debug_topk.py "astronomy admission requirements"
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).resolve().parent.parent
CHUNKS_JSON = ROOT / "web" / "public" / "data" / "chunks.json"
EMBEDDINGS_BIN = ROOT / "web" / "public" / "data" / "embeddings.bin"
EMBED_DIM = 384
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

MIN_SCORE = 0.4
COURSE_KEYWORD_RE = re.compile(r"\b(course|courses|class|classes)\b", re.I)

ALIASES = {
    "CPSC": ["computer"],
    "DSCI": ["data science"],
    "COGS": ["cognitive"],
    "LFS": ["land and food"],
    "KIN": ["kinesiology"],
    "ASTR": ["astronomy"],
    "BIOL": ["biology"],
    "BIOC": ["biochemistry"],
    "CHEM": ["chemistry"],
    "ECON": ["economics"],
    "GEOG": ["geography"],
    "MATH": ["mathematics"],
    "PHIL": ["philosophy"],
    "PHYS": ["physics"],
    "POLI": ["political science"],
    "PSYC": ["psychology"],
    "SOCI": ["sociology"],
    "astronomy": ["astronomy"],
    "biology": ["biology"],
    "biochemistry": ["biochemistry"],
    "chemistry": ["chemistry"],
    "economics": ["economics"],
    "geography": ["geography"],
    "mathematics": ["mathematics"],
    "math": ["mathematics"],
    "philosophy": ["philosophy"],
    "physics": ["physics"],
    "psychology": ["psychology"],
    "sociology": ["sociology"],
    "Sauder": ["commerce and business"],
    "VSE": ["vancouver school of economics"],
    "iSchool": ["school of information"],
}


def extract_course_codes(text: str) -> list[str]:
    seen = set()
    out = []
    for m in re.finditer(r"\b([A-Z]{3,5})(?:_V)?\s*(\d{2,4}[A-Z]?)\b", text, re.I):
        code = f"{m.group(1).upper()} {m.group(2).upper()}"
        if code not in seen:
            seen.add(code)
            out.append(code)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--k", type=int, default=8)
    args = ap.parse_args()

    chunks = json.loads(CHUNKS_JSON.read_text(encoding="utf-8"))
    matrix = np.fromfile(EMBEDDINGS_BIN, dtype=np.float32).reshape(-1, EMBED_DIM)
    assert matrix.shape[0] == len(chunks)

    model = SentenceTransformer(MODEL_NAME)
    qvec = model.encode([args.query], normalize_embeddings=True, convert_to_numpy=True)[0].astype(np.float32)
    raw_scores = matrix @ qvec
    scores = raw_scores.copy()

    wants_courses = bool(COURSE_KEYWORD_RE.search(args.query))
    requested = set(extract_course_codes(args.query))

    query_lower = args.query.lower()
    tokens = [t for t in re.split(r"[^a-z0-9]+", query_lower) if len(t) >= 4]
    alias_keywords: list[str] = []
    for alias, keywords in ALIASES.items():
        if re.search(rf"\b{re.escape(alias)}\b", args.query, re.I):
            alias_keywords.extend(k.lower() for k in keywords)
    program_needles = tokens + alias_keywords

    print(f"query: {args.query!r}")
    print(f"wants_courses: {wants_courses}")
    print(f"requested codes: {sorted(requested)}")
    print(f"tokens: {tokens}")
    print(f"alias_keywords: {alias_keywords}")
    print(f"program_needles: {program_needles}")
    print()

    if program_needles and not wants_courses:
        for i, c in enumerate(chunks):
            if c["kind"] != "program":
                continue
            title = c["title"].lower()
            if any(n in title for n in program_needles):
                scores[i] += 0.25

    if wants_courses:
        for i, c in enumerate(chunks):
            if c["kind"] == "course":
                scores[i] += 0.25

    for i, c in enumerate(chunks):
        if c["kind"] == "easter" and scores[i] <= 1:
            scores[i] = -np.inf

    order = np.argsort(-scores)

    if requested:
        print("Mode A would fire (course-code match)")
    elif alias_keywords and not wants_courses:
        print("Mode B fires (alias hit, !wantsCourses) — program/easter only, top 5 with alias-keyword filter")
        program_k = 5
        out = []
        for i in order:
            if len(out) >= program_k:
                break
            c = chunks[i]
            if c["kind"] not in ("program", "easter"):
                continue
            if scores[i] < MIN_SCORE:
                continue
            haystack = f"{c['title']}\n{c['text']}".lower()
            if not any(kw in haystack for kw in alias_keywords):
                continue
            out.append((i, c))
        print()
        for i, c in out:
            print(f"  [{scores[i]:+.4f}] (raw {raw_scores[i]:+.4f}) [{c['kind']}] {c['id']}")
            print(f"           title: {c['title']}")
            print(f"           text:  {c['text'][:200]!r}{'…' if len(c['text']) > 200 else ''}")
            print()
    else:
        print("Mode C (default semantic, top K distinct URLs above minScore)")
        out = []
        seen_urls = set()
        for i in order:
            if len(out) >= args.k:
                break
            if scores[i] < MIN_SCORE:
                continue
            c = chunks[i]
            if c["url"] in seen_urls:
                continue
            seen_urls.add(c["url"])
            out.append((i, c))
        print()
        for i, c in out:
            print(f"  [{scores[i]:+.4f}] (raw {raw_scores[i]:+.4f}) [{c['kind']}] {c['id']}")
            print(f"           title: {c['title']}")
            print()

    print()
    print("--- top 15 by post-boost score (any kind, pre-dedup) ---")
    for i in order[:15]:
        c = chunks[i]
        print(f"  [{scores[i]:+.4f}] (raw {raw_scores[i]:+.4f}) [{c['kind']:7s}] {c['title'][:70]}")


if __name__ == "__main__":
    main()
