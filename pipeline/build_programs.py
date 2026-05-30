"""Stage scraper/output/degree_programs.json into web/public/data/.

Slims each record to the fields the planner UI actually needs (drops
``children``, ``discovered_from``, ``breadcrumbs`` and a couple of fields
the planner ignores) and writes a single JSON array. Keeps the file under
control without losing the prose ``text`` block — that's what the planner's
prose-mode requirements panel renders.

Stdlib-only.

Usage:
    uv run build_programs.py
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRAPER_OUTPUT = ROOT / "scraper" / "output" / "degree_programs.json"
WEB_DATA = ROOT / "web" / "public" / "data" / "degree_programs.json"

# Fields kept in the slimmed planner-facing copy. The scraped record carries
# extras (children, discovered_from, depth, headings) that the planner never
# reads — dropping them shrinks the payload and keeps the contract narrow.
KEEP = (
    "url",
    "title",
    "program",
    "faculty",
    "level",
    "kind",
    "referenced_courses",
    "text",
)


def build() -> list[dict]:
    raw = json.loads(SCRAPER_OUTPUT.read_text(encoding="utf-8"))
    out: list[dict] = []
    for record in raw:
        out.append({k: record.get(k) for k in KEEP})
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", type=Path, default=WEB_DATA)
    args = ap.parse_args()

    payload = build()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Wrote {len(payload)} program records to {args.output}")


if __name__ == "__main__":
    main()
