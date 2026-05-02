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

**Not done — implementation has not started:**
- No scraper code written. `scraper/` contains only `pyproject.toml` + venv.
- No pipeline code written. `pipeline/` contains only `pyproject.toml` + venv.
- No app code beyond a placeholder `App.tsx`. The `components/`, `lib/`, `store/` directories are empty (`.gitkeep` only).
- No data files. `web/public/data/` is empty.

## What to do next (in order)

1. **`scraper/scrape_courses.py`** — async crawler for `https://vancouver.calendar.ubc.ca/course-descriptions/courses-subject`. Index page lists ~250 subject codes; each subject page lists all courses with title, credits, description, prerequisites, corequisites. Output one JSON record per course. Be respectful: 1 req/sec, real User-Agent string, **cache HTML to `scraper/cache/`** so re-runs don't hammer UBC. Add `--subject CPSC` flag to limit scope during development; full crawl is a separate flag.
2. **`scraper/scrape_programs.py`** — same pattern against `/faculties-colleges-and-schools` for degree-program requirement text.
3. **`pipeline/chunk_and_embed.py`** — load both JSON files, build self-contained chunks (one course or one program section per chunk), embed with `sentence-transformers/all-MiniLM-L6-v2`, write `web/public/data/chunks.json` (`[{id, kind, code, title, text, url}]`) + `web/public/data/embeddings.bin` (raw `Float32Array`, row-major, `N × 384`). The embedding model **must match** what the browser uses (`Xenova/all-MiniLM-L6-v2`) so vectors stay compatible.
4. **`web/src/lib/`** — `embed.ts` (transformers.js singleton, lazy-loads MiniLM), `retrieve.ts` (`loadEmbeddings()` once, `topK(query, k=8)` via cosine similarity), `llm.ts` (WebLLM wrapper around the Gemma 4 E2B model id discovered in the smoke test, exposes `streamChat(messages)`), `prompts.ts` (system prompt + RAG template).
5. **`web/src/components/`** — `Chat.tsx`, `ChatMessage.tsx`, `ModelLoader.tsx` (full-screen progress bar for first-visit Gemma 4 download), `Sidebar.tsx`, `CourseLookup.tsx`, `PrereqTree.tsx` (reactflow graph; v1 only regex-extracts course codes from the raw prereq string and renders one level — full boolean parsing is out of scope for v1).
6. **`web/src/store/`** — `chat.ts` (Zustand: messages, streaming flag), `conversations.ts` (localStorage persistence: `{id, title, messages, createdAt, updatedAt}`).

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
