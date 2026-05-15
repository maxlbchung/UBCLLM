# UBCLLM
https://maxlbchung.github.io/UBCLLM/

Browser-native UBC academic-advisor chatbot. Qwen3.5 2B runs locally in your browser via WebGPU, answering academic questions grounded in a RAG corpus scraped from UBC's official course calendar. No backend inference, no API keys, no data leaves your machine after the initial model + data download.

## Architecture

```
BUILD TIME (Python, offline)              RUNTIME (Browser, WebGPU)
─────────────────────────────             ─────────────────────────
UBC Calendar HTML                          User question
       │                                          │
       ▼                                          ▼
   scraper/  ──► courses.json         ┌──► transformers.js MiniLM (embed query)
                faculties.json        │           │
                degree_programs.json  │           ▼
       │                              │    cosine similarity → top-k chunks
       ▼                              │           │
   pipeline/ ──► chunks.json ─────────┤           ▼
                 embeddings.bin       │    system prompt + chunks
                                      │           │
                                      │           ▼
                                      └──► WebLLM Qwen3.5 2B → streamed answer
```

The corpus covers UBC Vancouver's full calendar: every course description (9,450 across 263 subject codes), every faculty/school/department hub, and every degree subtree — bachelors, masters, doctoral, and graduate/undergraduate certificates.

## Project layout

- `web/` — Vite + React + TypeScript app (the only thing deployed)
- `scraper/` — Python: crawls vancouver.calendar.ubc.ca, outputs JSON
- `pipeline/` — Python: chunks JSON, computes embeddings, writes static assets
- `smoke-test/` — One-off page to verify WebGPU + Qwen3.5 2B work in your browser

## Build pipeline

```
cd scraper  && uv run scrape_courses.py            # → output/courses.json
cd scraper  && uv run scrape_faculties.py          # → output/faculties.json
cd scraper  && uv run scrape_degree_programs.py    # → output/degree_programs.json
cd pipeline && uv run chunk_and_embed.py           # → web/public/data/{chunks.json, embeddings.bin}
cd web      && npm run dev                         # local dev server
cd web      && npm run build                       # static site → web/dist/
```

`scraper/output/*.json` is committed to git (it's the source of truth the CI workflow feeds to the pipeline). Re-running a scraper hits UBC's calendar — please respect their `robots.txt` and the 1 req/s rate limit.

## Requirements

- Node 20+, Python 3.11+ (3.12 recommended for the pipeline; sentence-transformers wheels may lag on 3.14), `uv`, git
- A browser with WebGPU enabled — Chrome 113+ or Edge 113+
- ~1 GB free disk for the Qwen3.5 2B (q4f16) weights (cached in IndexedDB after first visit)
