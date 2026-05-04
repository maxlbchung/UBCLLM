# UBCLLM

Browser-native UBC academic-advisor chatbot. Gemma 4 E2B runs in the user's browser via WebGPU, answering academic questions grounded in a RAG corpus scraped from UBC's official course calendar. No backend inference, no API keys.

- **Live:** https://maxlbchung.github.io/UBCLLM/
- **Repo:** https://github.com/maxlbchung/UBCLLM (deploys on push to `master`)
- **Latest version:** see `web/src/version.ts` (`APP_VERSION`); shown bottom-left in the running app.

Original setup plan (kept for reference; some details now stale):
**`C:\Users\max\.claude\plans\set-up-the-environment-nested-wigderson.md`**

## Architecture (one-liner per piece)

- **Build time** (offline, Python via `uv`): `scraper/` crawls `vancouver.calendar.ubc.ca` → JSON. `pipeline/` chunks + embeds with `sentence-transformers` (MiniLM-L6-v2, 384-dim) → ships `chunks.json` + `embeddings.bin` as static assets to `web/public/data/`.
- **Runtime** (browser only): Vite + React 19 + TS + Tailwind v4. `@xenova/transformers` embeds the user query with the *same* MiniLM (`Xenova/all-MiniLM-L6-v2`). Cosine similarity vs `embeddings.bin` (in-memory Float32Array, ~10.9k rows, brute-force, ~10 ms). Top-K chunks + system prompt + last 6 chat turns → `@mlc-ai/web-llm` streams Gemma 4 E2B output. Cited context entries are surfaced in the UI via `[N]` markers parsed out of the response.
- **Deploy:** GitHub Actions workflow re-runs the embedding pipeline on every push (Hugging Face cache speeds it up to ~1–2 min after the first run), then `npm install && npm run build`, then publishes `web/dist/` via `actions/deploy-pages@v4`.

## Project layout

```
UBCLLM/
├── web/                Vite + React 19 + TS app (the only thing deployed)
│   ├── src/
│   │   ├── lib/        embed.ts · retrieve.ts · llm.ts · prompts.ts
│   │   ├── store/      chat.ts (Zustand) · conversations.ts (localStorage-persisted)
│   │   ├── components/ Sidebar · Chat · ChatMessage · ModelLoader
│   │   │               · CourseLookup · PrereqTree
│   │   ├── App.tsx     view switcher: chat / lookup / prereq
│   │   └── version.ts  APP_VERSION (mirrored in package.json)
│   └── public/data/    chunks.json + embeddings.bin (regenerated in CI)
├── scraper/            Python 3.14 — crawls UBC calendar (output committed)
│   ├── common.py       rate-limited httpx + tenacity + on-disk HTML cache
│   ├── scrape_courses.py / scrape_programs.py
│   └── output/         courses.json (5.7 MB) + programs.json (2.9 MB)
├── pipeline/           Python 3.12 (pinned) — chunks + embeds (output regen in CI)
│   └── chunk_and_embed.py
├── smoke-test/         Standalone HTML — WebGPU + Gemma 4 E2B verification
└── .github/workflows/deploy.yml   pipeline → npm install → vite build → Pages
```

## Current state (as of v0.6.0)

The full v1 stack from the original plan is shipped and live. Highlights:

**Data corpus** — committed at `scraper/output/`:
- 9,450 courses across 263 UBC Vancouver subject codes (full calendar crawl).
- 800 program/faculty pages (BFS depth 4, capped at 800 — depth 3 wasn't fully drained, depth 4 not crawled; raise `--max-pages` if you want fuller coverage).
- The pipeline turns this into **10,910 chunks** (9,450 course + 1,460 program slices @ ~1,600 chars each) → 6.1 MB `chunks.json` + 16 MB `embeddings.bin`.
- Median chunk text size: ~246 chars (course) vs ~1,430 chars (program). Programs dominate the LLM context budget when retrieved.

**App features shipped:**
- **Chat** with streaming Gemma 4 E2B output, last 6 turns of history, RAG context from top-8 chunks per turn.
- **Course Lookup** — one-shot detail card by code (case-insensitive: `CPSC 110` / `cpsc110` / `CPSC_V 110` all work).
- **Prereq Tree** — full transitive BFS expansion, depth-capped at 12, cycle-safe; direct coreqs on the right (not transitively expanded). ReactFlow column layout, root on the right.
- **Sidebar** — conversation list (auto-titled from first user message), tool tabs, version badge bottom-left. Collapsible: toggle in the top-right shrinks it to a `w-12` strip; collapsed state is persisted via `useConversations.sidebarCollapsed`.
- **Conversation persistence** — `localStorage` key `ubcllm-conversations` via `zustand/middleware/persist`; on reload the active conversation rehydrates into `useChat`.
- **Citation surfacing** — `SYSTEM_PROMPT` requires `[N]` citations matching the bracketed numbering in `buildContext`; `ChatMessage` parses them, renders inline superscript chips linking to the chunk's UBC URL, and splits the sources panel into "Sources used" vs "Other retrieved context."
- **Model-load error recovery** — `ModelLoader` distinguishes network/cache errors from WebGPU/capability errors. Network failures (the usual "corrupted cached shard from an interrupted download" case) get a "Clear cache and try again" button that wipes `webllm/*` Cache Storage entries + IndexedDB databases and re-runs the load, plus a plain "Try again" fallback. Capability errors keep the original "needs WebGPU + ~2 GB" message.

**Important runtime contracts (don't break these silently):**
- **Retrieval modes + boosts in `topK`** (`web/src/lib/retrieve.ts`): three modes (A: course-code, B: program/easter via ALIASES hit, C: default semantic) with two additive boosts — `+1` program-title-match for any program OR easter chunk whose title substring-matches a query token, and `+0.5` course-keyword for any course OR easter chunk when the query says "course"/"class". Mode A uses string-contains-on-asked-code as the structural signal (no score boost), so the literal course always lands in the result regardless of MiniLM's clustering blindspot for course numbers. Easter chunks ride the same boosts as their kind-equivalent peers — kind-specific bonuses are deliberately avoided to keep the playing field level.
- **MLCEngine runs in a Web Worker** (`web/src/lib/llm.worker.ts` + `web/src/lib/llm.ts`): `CreateWebWorkerMLCEngine` keeps the GPUDevice + model pipeline owned by a worker process so brief tab-visibility / page-lifecycle events don't trigger device-lost → `engine.unload()` → "Buffer was unmapped" / "Model not loaded" cascades. `streamChat` still serializes calls via a shared promise tail + `resetChat()` to avoid the in-process buffer race, and on a stale-engine error it terminates the worker and respawns one (see `discardEngine()`).
- **Same MiniLM both sides**: `pipeline/chunk_and_embed.py` uses `sentence-transformers/all-MiniLM-L6-v2`; `web/src/lib/embed.ts` uses `Xenova/all-MiniLM-L6-v2`. Same weights, different distributions — both must be normalized so dot product == cosine.
- **CI uses `npm install`, not `npm ci`**: the lockfile is generated on Windows and skips Linux-only platform-optional packages (e.g. `@tailwindcss/oxide-linux-x64-gnu` and its `@emnapi/*` transitives), so `npm ci` on the Ubuntu runner fails. `npm install` resolves them on the runner.
- **`scraper/output/*.json` is committed.** Re-running the scraper hits UBC servers; the corpus snapshot in git is the source of truth that CI feeds to the pipeline.
- **`web/public/data/{chunks.json, embeddings.bin}` are regenerated in CI**, not committed. Locally, run `cd pipeline && uv run chunk_and_embed.py` once after pulling, then `npm run dev`.

**Open opportunities** (none of these block daily use):
- Programs crawl was capped at 800 — depth-4 leaves never reached. Bumping `--max-pages` would fill in deeper degree-requirement detail.
- Boolean prereq parsing ("one of CPSC 107, CPSC 110") is shown as raw text in chat, not modeled in the prereq tree.
- Sidebar can collapse, but there's no proper mobile drawer / hamburger pattern yet — small viewports still get the desktop layout, just narrower.
- "Clear cache" affordance is only surfaced on the model-load error screen. No general-purpose cache reset button in the running app.

## Versioning

The app version is shown in the bottom-left of the screen on the main page (Sidebar) and on the model-loading screen (ModelLoader badge). Format: `MAJOR.MINOR.PATCH`.

- **MAJOR** — only bump when the user explicitly tells you to.
- **SIGNIFICANT** — *big* changes only. A genuinely new top-level capability (e.g. a whole new tool view in the sidebar), a significant architectural shift (e.g. swapping the LLM runtime, replacing the retrieval index, restructuring the build pipeline), or a breaking change to a persisted data format. The rule of thumb: if you'd want to call it out in release notes as a headline, it's SIGNIFICANT. Otherwise it isn't.
- **PATCH** — everything else, and this is what you should default to. New components inside an existing feature, UX polish, prompt tweaks, layout refinements, error-handling improvements, bug fixes, dependency bumps, deploy/CI fixes, doc updates, small new affordances. When in doubt, PATCH.

Single source of truth: `web/src/version.ts` (`APP_VERSION`). Mirror it in `web/package.json` so npm tooling stays in sync.

**Workflow:** every time you push or land a change, bump the appropriate digit (almost always PATCH), edit both files, build, commit, push, then tell the user the new version number in your reply (e.g. "Pushed v0.8.2 — …").

## Gotchas worth knowing

- **Python 3.14 is the machine default** but the pipeline venv is pinned to 3.12. If you ever recreate the pipeline venv, do `uv python pin 3.12` first or it'll try 3.14 and fail on torch.
- **Tailwind v4** — uses `@import "tailwindcss";` in CSS plus the `@tailwindcss/vite` plugin. No PostCSS config, no `tailwind.config.js`. Don't follow Tailwind v3 setup guides.
- **WebLLM model IDs** — the smoke test auto-discovers Gemma 4 E2B variants from `prebuiltAppConfig.model_list` rather than hardcoding an ID. Do the same in `web/src/lib/llm.ts` so we don't break when WebLLM bumps versions.
- **Bash tool cwd persists across calls in this session.** Don't `cd web && npm install` in parallel with other directory-scoped commands — use `npm install --prefix <abs-path>` and `uv add --directory <abs-path>` instead. (Discovered the hard way during setup.)
- **Smoke test was confirmed working** on the user's hardware on 2026-05-02. Don't make them re-run it unless something materially changes (WebLLM version bump, switching browsers, etc.).
- **Citation contract in `SYSTEM_PROMPT`** — `web/src/lib/prompts.ts` instructs the model to cite context entries as `[N]`, and `ChatMessage.tsx` parses those markers to highlight which retrieved chunks the LLM actually used. Don't strip those instructions thinking they're filler — the UI's "Sources used" panel goes silent if you do, since it has no other signal.
- **Density is rem-based, not pixel-based.** `html { font-size: 20px }` in `web/src/index.css` makes Tailwind's rem-scaled classes render at 1.25× their nominal size for a more readable default. **Do not use arbitrary pixel sizes** like `text-[10px]` or `text-[11px]` — they bypass the scaling and look tiny. Prefer Tailwind's named scale (`text-xs`, `text-sm`, …) or rem-equivalent arbitrary values like `text-[0.625rem]` (≈10 px nominal → 12.5 px rendered) and `text-[0.6875rem]` (≈11 px → 13.75 px). Borders / dividers / 1 px lines stay in pixels on purpose so they don't get fuzzy.

## Running things

```
# First-time setup after a fresh clone (pipeline output is .gitignored):
cd pipeline && uv run chunk_and_embed.py     # generates web/public/data/{chunks.json, embeddings.bin}

# Day-to-day:
cd web      && npm run dev                    # local dev server (http://localhost:5173/UBCLLM/)
cd web      && npm run build                  # static build → web/dist/
cd scraper  && uv run scrape_courses.py       # full crawl, ~10 min at 1 req/s
cd scraper  && uv run scrape_programs.py      # full crawl, ~13 min (depth 4, max 800)
cd scraper  && uv run scrape_courses.py --subject CPSC --limit 1   # debug

python -m http.server 8000 --directory smoke-test   # WebGPU smoke test page

# Deploy: just push to master. The Action regenerates data + builds + publishes.
git push
```

## Verification recipes (post-deploy)

- "What are the prerequisites for CPSC 110?" → grounded answer, `[N]` citation, CPSC 110 highlighted in "Sources used".
- "What are the prerequisites for FAKE 999?" → "I don't have that information in the UBC calendar." No citations, all 8 sources fall under "Other retrieved context" un-highlighted.
- Reload page → conversation list survives, active conversation rehydrates, model loads from IndexedDB cache (instant).
- Course Lookup: type `cpsc110` (no space, lowercase) → CPSC 110 detail card.
- Prereq Tree: type `CPSC 320` → multi-level fan with MATH/CPSC chain reaching back several depths.
