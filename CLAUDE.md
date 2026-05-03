# UBCLLM

Browser-native UBC academic-advisor chatbot. Gemma 4 E2B runs in the user's browser via WebGPU, answering academic questions grounded in a RAG corpus scraped from UBC's official course calendar. No backend inference, no API keys.

## Architecture (one-liner per piece)

- **Build time** (offline, Python via `uv`): `scraper/` crawls `vancouver.calendar.ubc.ca` → JSON. `pipeline/` chunks + embeds with `sentence-transformers` (MiniLM-L6-v2, 384-dim) → ships `chunks.json` + `embeddings.bin` as static assets.
- **Runtime** (browser only): Vite + React + TS + Tailwind v4. `@xenova/transformers` embeds the user query with the *same* MiniLM. Cosine similarity vs `embeddings.bin` (in-memory Float32Array, ~10k rows, brute-force is fine). Top-k chunks + system prompt + last 6 chat turns → `@mlc-ai/web-llm` streams Gemma 4 E2B output.

Full plan with rationale, file-by-file layout, and verification steps:
**`C:\Users\max\.claude\plans\set-up-the-environment-nested-wigderson.md`**

## Project layout

```
UBCLLM/
├── web/             Vite + React + TS app — only thing deployed
│   ├── src/{components,lib,store}/    empty, ready for implementation
│   └── public/data/                   chunks.json + embeddings.bin land here
├── scraper/         Python 3.14 — crawls UBC calendar
├── pipeline/        Python 3.12 (pinned) — chunks + embeds
└── smoke-test/      Standalone HTML — WebGPU + Gemma 4 E2B verification
```

## Progress (2026-05-02)

**Done — environment fully set up:**
- Git repo initialized, `.gitignore` + `README.md` committed (single commit `cfe0696`).
- `web/` scaffolded with Vite + React + TS. Tailwind v4 configured via `@tailwindcss/vite` plugin (no `tailwind.config.js` needed in v4). Boilerplate stripped, placeholder `App.tsx` in place. `npm run build` clean (191 KB JS / 7.6 KB CSS).
- npm deps installed: `@mlc-ai/web-llm`, `@xenova/transformers`, `zustand`, `reactflow`, `tailwindcss`, `@tailwindcss/vite`.
- `scraper/` Python project initialized with `uv`. Deps: `httpx`, `selectolax`, `tenacity`. Uses system Python 3.14.
- `pipeline/` Python project pinned to **3.12** (`.python-version`, `requires-python = ">=3.12,<3.13"`). Deps: `sentence-transformers`, `numpy` (which pulled `torch` 2.11). 3.14 is avoided here because torch wheels lag on bleeding-edge CPython.
- `smoke-test/index.html` built and **verified on user's hardware**: WebGPU available, Gemma 4 E2B loaded via WebLLM, generation streamed. Stack is validated end-to-end — no need to re-prove the hardware story.
- All scaffold work after the initial commit is **uncommitted** — user wants to review before committing.

**Done — full v1 stack (uncommitted at time of writing):**

- `pipeline/chunk_and_embed.py` — loads `scraper/output/{courses,programs}.json`, builds one chunk per course + one chunk per ~1.6 KB slice of program text, embeds with `sentence-transformers/all-MiniLM-L6-v2` (L2-normalized so cosine == dot product), writes `web/public/data/chunks.json` + `embeddings.bin`. Last run: **10,910 chunks → 6.1 MB JSON + 16 MB embeddings**.
- `web/` app:
  - `src/lib/embed.ts` — transformers.js MiniLM singleton (Xenova/all-MiniLM-L6-v2, quantized).
  - `src/lib/retrieve.ts` — fetches `data/chunks.json` + `data/embeddings.bin` once, runs cosine top-K. Also exposes `getCourseIndex()`, `parseCourseChunk()`, and `extractCourseCodes()` for the lookup + prereq-tree views.
  - `src/lib/llm.ts` — WebLLM wrapper that auto-discovers the Gemma 4 E2B model id (preferring q4f16 quant). Streams chat completions.
  - `src/lib/prompts.ts` — system prompt that hard-bans hallucinated course numbers + a RAG context template.
  - `src/store/chat.ts` — current conversation messages + streaming flag (Zustand).
  - `src/store/conversations.ts` — saved conversation list, active id, view state, `localStorage`-persisted via `zustand/middleware`. Auto-titles chats from the first user message.
  - `src/components/`: `Sidebar` (history + tool buttons), `Chat` + `ChatMessage`, `ModelLoader` (WebGPU pre-flight + first-load progress bar), `CourseLookup` (one-shot course detail card), `PrereqTree` (reactflow graph showing direct prereqs/coreqs as a fan).
  - `App.tsx` switches between Chat / Course Lookup / Prereq Tree based on `useConversations.view`.
- `web/vite.config.ts` reads `VITE_BASE_PATH` (defaults `/UBCLLM/`) so GitHub Pages serves the bundle from the right sub-path.
- `.github/workflows/deploy.yml` — runs the embedding pipeline + Vite build on every push to `master`/`main` and publishes via `actions/deploy-pages@v4`.
- `.gitignore` — `scraper/output/*.json` is **committed** so CI doesn't have to re-scrape UBC; `pipeline/output/`, `web/public/data/*.bin`, and `web/public/data/chunks.json` stay regenerable in CI.

**Done earlier — scrapers:**
- `scraper/common.py` — shared `RateLimitedClient` (1 req/s gate, tenacity retry/backoff) + on-disk HTML cache keyed by URL hash. Real User-Agent string with contact email. `OUTPUT_DIR = scraper/output/` (gitignored).
- `scraper/scrape_courses.py` — async crawler for `/course-descriptions/courses-subject`. Discovers ~263 subject pages from the index, parses each `<h3>SUBJ_V NUM (credits) <strong>Title</strong></h3>` + following `<p>` description. Splits `Prerequisite/Corequisite/Equivalency/Recommended` labels out of the description. Stores both `code` ("CPSC 110") and `raw_code` ("CPSC_V 110"); credits as both raw string and parsed int (None for ranges like "1-6"). Flags: `--subject CPSC`, `--limit N`, `--refresh`, `--rate`. Verified on CPSC 2026-05-02: 112 courses, 50 with prereqs, 1 with coreq, 15 variable-credit.
- `scraper/scrape_programs.py` — BFS crawler under `/faculties-colleges-and-schools`. Follows internal `/node/N` links by letting httpx follow the 301 to the canonical path; uses `<link rel="canonical">` to dedupe. Strips nav/header/footer/breadcrumb chrome before extracting text. Output: `{url, title, breadcrumbs, headings, text, depth, discovered_from, children}`. Defaults: `--depth 4 --max-pages 800`. Smoke-tested at depth=1, max=5.

**Not done — implementation has not started:**
- No pipeline code written. `pipeline/` contains only `pyproject.toml` + venv.
- No app code beyond a placeholder `App.tsx`. The `components/`, `lib/`, `store/` directories are empty (`.gitkeep` only).
- No data files. `web/public/data/` is empty.
- Full courses + programs crawls have not been run yet (only smoke tests).

## What to do next (in order)

1. **Run the full crawls** once the user is ready: `uv run scrape_courses.py` (≈263 pages, ~5 min at 1 req/s) and `uv run scrape_programs.py` (depth 4 BFS, capped at 800 pages, ~13 min). Outputs land in `scraper/output/{courses,programs}.json`.
2. **`pipeline/chunk_and_embed.py`** — load both JSON files, build self-contained chunks (one course or one program section per chunk), embed with `sentence-transformers/all-MiniLM-L6-v2`, write `web/public/data/chunks.json` (`[{id, kind, code, title, text, url}]`) + `web/public/data/embeddings.bin` (raw `Float32Array`, row-major, `N × 384`). The embedding model **must match** what the browser uses (`Xenova/all-MiniLM-L6-v2`) so vectors stay compatible.
3. **`web/src/lib/`** — `embed.ts` (transformers.js singleton, lazy-loads MiniLM), `retrieve.ts` (`loadEmbeddings()` once, `topK(query, k=8)` via cosine similarity), `llm.ts` (WebLLM wrapper around the Gemma 4 E2B model id discovered in the smoke test, exposes `streamChat(messages)`), `prompts.ts` (system prompt + RAG template).
4. **`web/src/components/`** — `Chat.tsx`, `ChatMessage.tsx`, `ModelLoader.tsx` (full-screen progress bar for first-visit Gemma 4 download), `Sidebar.tsx`, `CourseLookup.tsx`, `PrereqTree.tsx` (reactflow graph; v1 only regex-extracts course codes from the raw prereq string and renders one level — full boolean parsing is out of scope for v1).
5. **`web/src/store/`** — `chat.ts` (Zustand: messages, streaming flag), `conversations.ts` (localStorage persistence: `{id, title, messages, createdAt, updatedAt}`).

**Verification once it all works:**
- "What are the prerequisites for CPSC 110?" → cites the actual prereq from retrieved context.
- "What are the prerequisites for FAKE 999?" → says "I don't have that information" (hallucination guard).
- Reload page → conversations persist, model loads from IndexedDB cache without re-downloading.

## Gotchas worth knowing

- **Python 3.14 is the machine default** but the pipeline venv is pinned to 3.12. If you ever recreate the pipeline venv, do `uv python pin 3.12` first or it'll try 3.14 and fail on torch.
- **Tailwind v4** — uses `@import "tailwindcss";` in CSS plus the `@tailwindcss/vite` plugin. No PostCSS config, no `tailwind.config.js`. Don't follow Tailwind v3 setup guides.
- **WebLLM model IDs** — the smoke test auto-discovers Gemma 4 E2B variants from `prebuiltAppConfig.model_list` rather than hardcoding an ID. Do the same in `web/src/lib/llm.ts` so we don't break when WebLLM bumps versions.
- **Bash tool cwd persists across calls in this session.** Don't `cd web && npm install` in parallel with other directory-scoped commands — use `npm install --prefix <abs-path>` and `uv add --directory <abs-path>` instead. (Discovered the hard way during setup.)
- **Smoke test was confirmed working** on the user's hardware on 2026-05-02. Don't make them re-run it unless something materially changes (WebLLM version bump, switching browsers, etc.).

## Running things

```
cd web      && npm run dev              # local dev server
cd web      && npm run build            # static build → web/dist/
cd scraper  && uv run scrape_courses.py # once written
cd pipeline && uv run chunk_and_embed.py

python -m http.server 8000 --directory smoke-test   # smoke-test page, http://localhost:8000
```
