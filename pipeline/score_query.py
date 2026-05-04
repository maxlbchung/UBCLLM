"""One-shot helper: score a query against a chunk by id (or all easter chunks).

Usage:
  uv run score_query.py "who is the best astronomy professor?"
  uv run score_query.py "who is the best astronomy professor?" --id easter:best-astronomy-prof
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).resolve().parent.parent
CHUNKS_JSON = ROOT / "web" / "public" / "data" / "chunks.json"
EMBEDDINGS_BIN = ROOT / "web" / "public" / "data" / "embeddings.bin"
EMBED_DIM = 384
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--id", help="Score only this chunk id (otherwise all easter chunks).")
    args = ap.parse_args()

    chunks = json.loads(CHUNKS_JSON.read_text(encoding="utf-8"))
    matrix = np.fromfile(EMBEDDINGS_BIN, dtype=np.float32).reshape(-1, EMBED_DIM)
    assert matrix.shape[0] == len(chunks), f"shape mismatch: {matrix.shape[0]} vs {len(chunks)}"

    model = SentenceTransformer(MODEL_NAME)
    qvec = model.encode([args.query], normalize_embeddings=True, convert_to_numpy=True)[0].astype(np.float32)

    targets = []
    for i, c in enumerate(chunks):
        if args.id and c["id"] != args.id:
            continue
        if not args.id and c["kind"] != "easter":
            continue
        targets.append((i, c))

    print(f"query: {args.query!r}")
    print(f"matrix: {matrix.shape}, chunks: {len(chunks)}")
    print()
    for i, c in targets:
        score = float(np.dot(matrix[i], qvec))
        print(f"  [{score:+.4f}]  {c['id']}")
        print(f"           text: {c['text']!r}")


if __name__ == "__main__":
    main()
