# UBCLLM

Browser-native UBC academic-advisor chatbot. Qwen3.5 2B runs in the user's browser via WebGPU, answering academic questions grounded in a RAG corpus scraped from UBC's official course calendar. No backend inference, no API keys.

- **Live:** https://maxlbchung.github.io/UBCLLM/
- **Repo:** https://github.com/maxlbchung/UBCLLM (deploys on push to `master`)
- **Latest version:** see `web/src/version.ts` (`APP_VERSION`); shown bottom-left in the running app.

Original setup plan (kept for reference; some details now stale):
**`C:\Users\max\.Codex\plans\set-up-the-environment-nested-wigderson.md`**

## Architecture (one-liner per piece)

- **Build time** (offline, Python via `uv`): `scraper/` crawls `vancouver.calendar.ubc.ca` → JSON. `pipeline/` chunks + embeds with `sentence-transformers` (MiniLM-L6-v2, 384-dim) → ships `chunks.json` + `embeddings.bin` as static assets to `web/public/data/`.
- **Runtime** (browser only): Vite + React 19 + TS + Tailwind v4. `@xenova/transformers` embeds the user query with the *same* MiniLM (`Xenova/all-MiniLM-L6-v2`). Cosine similarity vs `embeddings.bin` (in-memory Float32Array, ~10.9k rows, brute-force, ~10 ms). Top-K chunks + system prompt + current user message → `@mlc-ai/web-llm` streams Qwen3.5 2B output. Each turn is single-shot — no chat history is sent (fact-bleed prevention). Cited context entries are surfaced in the UI via `[N]` markers parsed out of the response.
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
│   ├── scrape_courses.py            course descriptions per subject code
│   ├── scrape_faculties.py          faculty/school/department hub pages (depth 2)
│   ├── scrape_degree_programs.py    every degree subtree — BA/BSc/MSc/PhD/cert
│   └── output/         courses.json + faculties.json + degree_programs.json
├── pipeline/           Python 3.12 (pinned) — chunks + embeds (output regen in CI)
│   └── chunk_and_embed.py
├── smoke-test/         Standalone HTML — WebGPU + Qwen3.5 2B verification
└── .github/workflows/deploy.yml   pipeline → npm install → vite build → Pages
```

## Current state (as of v0.6.0)

The full v1 stack from the original plan is shipped and live. Highlights:

**Data corpus** — committed at `scraper/output/`:
- 9,450 courses across 263 UBC Vancouver subject codes (full calendar crawl).
- **Faculty hubs** (`faculties.json`) — shallow BFS (depth 2, cap 300) over `/faculties-colleges-and-schools/` that keeps only the navigation layer: faculty overviews, school overviews, departmental hubs, research centres. Anything that *looks like* a degree root (Bachelor/Master/Doctor/certificate by title or slug) is filtered out during the crawl so this set never overlaps with the degree set. Each record carries `kind` (faculty_overview / school_overview / college_overview / department / research_centre / vantage / other).
- **Degree programs** (`degree_programs.json`) — self-contained scraper that does its own shallow BFS to discover every "Bachelor of …" / "Master of …" / "Doctor of …" / certificate landing page, then exhausts each subtree within its URL prefix. Covers undergraduate, masters, doctoral, and certificate/diploma levels in a single pass — graduate programs are no longer excluded. Each record carries `program`, `faculty`, `level` (undergraduate / masters / doctoral / certificate), `kind` (degree_overview / degree_requirements / specialization / major / minor / honours / admission / regulations / curriculum / advising / coop / dual_degree / other), and a `referenced_courses` list extracted by course-code regex.
- The pipeline turns this into chunks: course rows + faculty-hub rows + degree-program rows. Degree chunks carry a richer prefix (`Program: … · Faculty: … · Level: … · Section: …`) so a query like "what's the MSc thesis option" lands close. When the same URL appears in both `faculties.json` and `degree_programs.json`, the degree record wins (richer metadata).

**App features shipped:**
- **Chat** with streaming Qwen3.5 2B output, single-shot per turn (no chat history sent — fact-bleed prevention), RAG context from top-8 chunks per turn.
- **Course Lookup** — one-shot detail card by code (case-insensitive: `CPSC 110` / `cpsc110` / `CPSC_V 110` all work).
- **Prereq Tree** — full transitive BFS expansion, depth-capped at 12, cycle-safe; direct coreqs on the right (not transitively expanded). Boolean structure modeled: `one of A, B, C` renders as a single dropdown block, `Either (a) … or (b) …` as a stacked group with radio selectors. Selecting an option swaps the upstream subtree to reflect the chosen branch. Custom ReactFlow node types in `DisjunctionNode.tsx` / `EitherOrNode.tsx`; column layout, root on the right.
- **Sidebar** — conversation list (auto-titled from first user message), tool tabs, version badge bottom-left. Collapsible: toggle in the top-right shrinks it to a `w-12` strip; collapsed state is persisted via `useConversations.sidebarCollapsed`.
- **Conversation persistence** — `localStorage` key `ubcllm-conversations` via `zustand/middleware/persist`; on reload the active conversation rehydrates into `useChat`.
- **Citation surfacing** — `buildSystemPrompt('default')` requires `[N]` citations matching the bracketed numbering in `buildContext`; `ChatMessage` parses them, renders inline superscript chips linking to the chunk's UBC URL, and splits the sources panel into "Sources used" vs "Other retrieved context."
- **Model-load error recovery** — `ModelLoader` distinguishes network/cache errors from WebGPU/capability errors. Network failures (the usual "corrupted cached shard from an interrupted download" case) get a "Clear cache and try again" button that wipes `webllm/*` Cache Storage entries + IndexedDB databases and re-runs the load, plus a plain "Try again" fallback. Capability errors keep the original "needs WebGPU + ~2.5 GB GPU memory" message.
- **Calendar widget** (Home page) — read-only `CalendarWidget` showing academic deadlines / statutory holidays. Two independent filter chips, side-by-side mini-grid + upcoming list on desktop (stacks on mobile), prev/next month navigation, click month header to jump back to today. Fed by two scrapers (`scrape_academic_dates.py`, `scrape_holidays.py`) → normalized in `pipeline/build_calendar.py` → consumed as `web/public/data/calendar.json`. Calendar data is **not** in the RAG corpus on purpose (date-keyed facts don't belong in semantic retrieval).

**Important runtime contracts (don't break these silently):**
- **Retrieval modes + boosts in `topK`** (`web/src/lib/retrieve.ts`): three modes (A: course-code, B: program/easter via ALIASES hit, C: default semantic) with two additive boosts — a program-title-match boost for any program OR easter chunk whose title substring-matches a query token, and a course-keyword boost for course chunks (only) when the query says "course"/"class". Mode A uses string-contains-on-asked-code as the structural signal (no score boost), so the literal course always lands in the result regardless of MiniLM's clustering blindspot for course numbers. Easter chunks ride the program-title boost (since it reflects real topical alignment) but deliberately do NOT ride the course-keyword boost (which is unconditional on kind and would let easters win against on-topic courses for unrelated queries).
- **MLCEngine runs in a Web Worker** (`web/src/lib/llm.worker.ts` + `web/src/lib/llm.ts`): `CreateWebWorkerMLCEngine` keeps the GPUDevice + model pipeline owned by a worker process so brief tab-visibility / page-lifecycle events don't trigger device-lost → `engine.unload()` → "Buffer was unmapped" / "Model not loaded" cascades. `streamChat` still serializes calls via a shared promise tail + `resetChat()` to avoid the in-process buffer race, and on a stale-engine error it terminates the worker and respawns one (see `discardEngine()`).
- **Same MiniLM both sides**: `pipeline/chunk_and_embed.py` uses `sentence-transformers/all-MiniLM-L6-v2`; `web/src/lib/embed.ts` uses `Xenova/all-MiniLM-L6-v2`. Same weights, different distributions — both must be normalized so dot product == cosine.
- **CI uses `npm install`, not `npm ci`**: the lockfile is generated on Windows and skips Linux-only platform-optional packages (e.g. `@tailwindcss/oxide-linux-x64-gnu` and its `@emnapi/*` transitives), so `npm ci` on the Ubuntu runner fails. `npm install` resolves them on the runner.
- **`scraper/output/*.json` is committed.** Re-running the scraper hits UBC servers; the corpus snapshot in git is the source of truth that CI feeds to the pipeline.
- **`web/public/data/{chunks.json, embeddings.bin, calendar.json}` are regenerated in CI**, not committed. Locally, run `cd pipeline && uv run chunk_and_embed.py && uv run build_calendar.py` once after pulling, then `npm run dev`. `calendar.json` is a separate pipeline from the RAG corpus — it normalizes the calendar-source scrapers (academic_dates / holidays) into one date-sorted JSON for the home-page widget; do not merge it into `chunks.json`.
- **Prereq AST parser** (`web/src/lib/prereqAst.ts`): recursive-descent over a small token alphabet (`one of`, `all of`, `either`, `and`, `or`, `;`, `.`, `,`, parens, branch labels, course codes, free text). Emits `Expr = And | Or-dropdown | Or-stacked | Code | Literal`. `parsePrereq` is null-safe for empty/whitespace input; unknown tokens collapse into `Literal` so the parser never throws on weird strings. `displayExpr` flattens an expression to a label string for dropdown / radio options. Top-level literals are dropped from the prereq tree (preserved as text in chat). Selection state in `PrereqTree` is keyed by `${ownerCourseCode}::${pathInExpr}` so toggling one disjunction doesn't perturb others, and selections persist across root-course switches.

**Open opportunities** (none of these block daily use):
- Other top-level calendar sections aren't crawled yet: `/campus-wide-policies-and-regulations/...` (academic standing, withdrawals, plagiarism), `/admissions/...` (transfer credit, AP/IB, English language), `/examinations/...`, `/fees/...`, `/awards-and-financial-aid/...`. Pattern matches `scrape_faculties.py` — would need one new seeded scraper per section (or a parametrized one). (Sessional dates from `/dates-and-deadlines` are now covered by `scrape_academic_dates.py`, but only the term-dates and course-drop tables — the wider `/academic-year/...` overview pages remain un-scraped.)
- Sidebar can collapse, but there's no proper mobile drawer / hamburger pattern yet — small viewports still get the desktop layout, just narrower.
- "Clear cache" affordance is only surfaced on the model-load error screen. No general-purpose cache reset button in the running app.

## Versioning

The app version is shown in the bottom-left of the screen on the main page (Sidebar) and on the model-loading screen (ModelLoader badge). Format: `MAJOR.MINOR.PATCH`.

- **MAJOR** — only bump when the user explicitly tells you to.
- **SIGNIFICANT** — A significant architectural shift, new feature added, model change, etc. 
- **PATCH** — everything else, and this is what you should default to. UX polish, prompt tweaks, layout refinements, error-handling improvements, bug fixes, dependency bumps, deploy/CI fixes, doc updates, small new affordances. When in doubt, PATCH.

Single source of truth: `web/src/version.ts` (`APP_VERSION`). Mirror it in `web/package.json` so npm tooling stays in sync.

**Workflow:** every time you push or land a change, bump the appropriate digit (almost always PATCH), edit both files, build, commit, push, then tell the user the new version number in your reply (e.g. "Pushed v0.8.2 — …").

## Gotchas worth knowing

- **Python 3.14 is the machine default** but the pipeline venv is pinned to 3.12. If you ever recreate the pipeline venv, do `uv python pin 3.12` first or it'll try 3.14 and fail on torch.
- **Tailwind v4** — uses `@import "tailwindcss";` in CSS plus the `@tailwindcss/vite` plugin. No PostCSS config, no `tailwind.config.js`. Don't follow Tailwind v3 setup guides.
- **WebLLM model IDs** — both the smoke test and `web/src/lib/llm.ts` auto-discover Qwen3.5 2B variants from `prebuiltAppConfig.model_list` (excluding any `Coder`/`Math` siblings that share the `2B` stem) rather than hardcoding an ID, so we don't break when WebLLM bumps versions. Quantization preference: `q4f16_1` > `q4f32_1`. Note: Qwen3 / Qwen3.5 dropped the explicit `Instruct` suffix that Qwen2.5 used — the base model is chat-tuned by default.
- **Bash tool cwd persists across calls in this session.** Don't `cd web && npm install` in parallel with other directory-scoped commands — use `npm install --prefix <abs-path>` and `uv add --directory <abs-path>` instead. (Discovered the hard way during setup.)
- **Smoke test was confirmed working** on the user's hardware on 2026-05-02. Don't make them re-run it unless something materially changes (WebLLM version bump, switching browsers, etc.).
- **Citation contract in the system prompt** — `web/src/lib/prompts.ts` exports `buildSystemPrompt(mode)` (modes: `default` / `easter` / `bareSubject`); the default + easter rule blocks both require `[N]` citations matching the bracketed numbering in `buildContext`, and `ChatMessage.tsx` parses those markers to highlight which retrieved chunks the LLM actually used. Don't strip those instructions thinking they're filler — the UI's "Sources used" panel goes silent if you do, since it has no other signal. The rules sit in the system role (not the user-message tail) so Qwen3.5 2B treats them as policy and stops echoing scaffolding phrases like "earlier user queries" / "no source above is relevant" back into replies.
- **Density is rem-based, not pixel-based.** `html { font-size: 20px }` in `web/src/index.css` makes Tailwind's rem-scaled classes render at 1.25× their nominal size for a more readable default. **Do not use arbitrary pixel sizes** like `text-[10px]` or `text-[11px]` — they bypass the scaling and look tiny. Prefer Tailwind's named scale (`text-xs`, `text-sm`, …) or rem-equivalent arbitrary values like `text-[0.625rem]` (≈10 px nominal → 12.5 px rendered) and `text-[0.6875rem]` (≈11 px → 13.75 px). Borders / dividers / 1 px lines stay in pixels on purpose so they don't get fuzzy.

## Running things

```
# First-time setup after a fresh clone (pipeline output is .gitignored):
cd pipeline && uv run chunk_and_embed.py     # generates web/public/data/{chunks.json, embeddings.bin}
cd pipeline && uv run build_calendar.py      # generates web/public/data/calendar.json

# Day-to-day:
cd web      && npm run dev                    # local dev server (http://localhost:5173/UBCLLM/)
cd web      && npm run build                  # static build → web/dist/
cd scraper  && uv run scrape_courses.py            # full crawl, ~10 min at 1 req/s
cd scraper  && uv run scrape_faculties.py          # shallow hubs (depth 2, cap 300), ~3-5 min
cd scraper  && uv run scrape_degree_programs.py    # all degree subtrees (BA/MSc/PhD/cert), ~30-60 min cold
cd scraper  && uv run scrape_academic_dates.py     # /dates-and-deadlines tables, < 5 s
cd scraper  && uv run scrape_holidays.py           # hr.ubc.ca/statutory-holidays, < 5 s
cd scraper  && uv run scrape_courses.py --subject CPSC --limit 1   # debug
cd scraper  && uv run scrape_degree_programs.py --only "Master of"  # one level, debug

python -m http.server 8000 --directory smoke-test   # WebGPU smoke test page

# Deploy: just push to master. The Action regenerates data + builds + publishes.
git push
```

## Verification recipes (post-deploy)

- "What are the prerequisites for CPSC 110?" → grounded answer, `[N]` citation, CPSC 110 highlighted in "Sources used".
- "What are the prerequisites for FAKE 999?" → "I don't have access to that information." No citations, all 8 sources fall under "Other retrieved context" un-highlighted.
- Reload page → conversation list survives, active conversation rehydrates, model loads from IndexedDB cache (instant).
- Course Lookup: type `cpsc110` (no space, lowercase) → CPSC 110 detail card.
- Prereq Tree: type `CPSC 320` → multi-level fan with MATH/CPSC chain reaching back several depths.
