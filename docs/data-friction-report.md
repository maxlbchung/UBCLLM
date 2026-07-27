# UBC Vancouver Calendar Data — Access & Structure Friction Report

**Author:** Max Chung · **Date:** 2026-07-27
**Context:** Notes from building [Reodite](https://reodite.com), a student-facing academic assistant built entirely on UBC's public course calendar.

This is a downstream consumer's field report, not a complaint. Everything below was
worked around successfully — the tool ships and works. The point is to record *where
the friction was*, because each item is a place where the next person to build on this
data will spend the same weeks I did.

All figures are measured against the committed corpus (9,489 courses / 576 degree-program
pages / 198 faculty hub pages) as of 2026-07-27. JSON:API observations were verified
2026-05-29.

---

## Summary

| | |
|---|---|
| Corpus assembled | 9,489 courses · 576 program pages · 198 faculty hubs |
| `field_course_prerequisite` populated, out of 9,603 course nodes | **0** |
| Courses whose prerequisites exist only as English prose | **3,098** (100% of those that have any) |
| Program pages that defeated automated classification | **248 / 576 (43%)** |
| Faculty pages that defeated automated classification | **168 / 198 (85%)** |
| Program pages with no machine-linkable course references | **282 / 576 (49%)** |
| Lines of parser/scraper written purely to compensate | **~2,960** |

The single highest-leverage fix is **prerequisites as structured data**. It alone accounts
for roughly half the engineering cost of the project.

---

## Part 1 — Data we could not find at all

These are gaps in public availability, not quality problems.

### 1.1 Course sections, seat counts, and timetable
The calendar describes courses *in the abstract* — it does not say when a course is
actually offered, by whom, in which term, or whether seats remain. That information
appears to live behind Workday Student, with no public API we were able to locate.

**Consequence:** the most common student question — *"can I actually take this next
term?"* — is unanswerable. Every course-planning feature stops at the theoretical level.
This is the single biggest functional gap in the product.

### 1.2 Instructor assignments
Not present in the calendar in any form.

### 1.3 Historical grade distributions
No official public source found. A third-party service (`ubcgrades.com`) publishes what
it describes as historical UBC grade data; we did not use it and have not independently
verified its provenance or licensing.

### 1.4 Program → course relationships as data
Degree requirements are narrative HTML. There is no machine-readable statement of
"Program X requires courses A, B, and one of C/D." We extract course codes with a regex
over page text, which recovers mentions but not *meaning* — it cannot distinguish a
required course from a recommended one, an example, or a course named only to exclude it.

**49% of program pages (282/576) yield zero course references at all**, meaning the
requirements are phrased in prose that never names a course code directly
("two upper-level electives in the department").

### 1.5 Hierarchy is not recoverable through the API
This one is subtle and cost us a full migration attempt.

The calendar runs Drupal with JSON:API enabled at `/jsonapi` — genuinely useful, and we
migrated the course scraper onto it. But the **faculty/school/department hierarchy of a
program page is carried only in the rendered breadcrumb trail**. `menu_link_content`
requires the `administer menu` permission and returns empty for anonymous users, and
nodes carry no breadcrumb field.

**Consequence:** we get clean faculty names — "The Faculty of Forestry and Environmental
Stewardship" — *only* by scraping rendered HTML. Through the API alone, the best available
fallback is de-slugging the URL, which degrades to "Faculty Forestry And Environmental
Stewardship". So two of our three scrapers are permanently stuck on HTML parsing, purely
to recover a hierarchy the CMS already knows internally.

---

## Part 2 — Data that exists, but not in a usable shape

### 2.1 Prerequisites are English prose encoding boolean logic

**This is the headline finding.** A structured prerequisite field exists in the schema and
is empty everywhere.

Across all **9,603 course nodes** returned by `/jsonapi/node/course`,
`field_course_prerequisite` is populated **zero times**. Meanwhile 2,767 of those nodes
carry a prerequisite inline in `field_course_description`, following the literal label
`Prerequisite:`. The field is not merely sparse — it is universally unpopulated, while the
information it is meant to hold demonstrably exists a few characters away in a prose field.

That prose encodes real boolean algebra. Across 3,098 courses carrying prerequisite text
(mean 50 characters, max 381):

| Construct | Share |
|---|---|
| `one of …` (disjunction) | 34.5% |
| `all of …` (conjunction) | 16.8% |
| `and` | 30.7% |
| `or` | 26.6% |
| `Either (a) … or (b) …` (labelled branches) | 6.9% |
| Year-standing conditions ("third-year standing") | 14.0% |
| Instructor/department permission | 4.0% |
| Numeric grade thresholds ("a score of 65% or higher") | 2.4% |

A representative real value:

> `Either (a) one of STAT_V 200, STAT_V 203, BIOL_V 300, STAT_V 251, COMM_V 291, ECON_V 325, FRST_V 231, PSYC_V 218, PSYC_V 366 and one of MATH_V 302, STAT_V 302; or (b) DSCI_V 200 and STAT_V 201 and one of MATH_V 302, STAT_V 302; or (c) a score of 65% or higher in one of MATH_V 302, STAT_V 302.`

That is a nested boolean expression with a numeric threshold, expressed in a natural
language string. To render a prerequisite tree we had to write a **1,417-line
recursive-descent parser** over an ad-hoc token alphabet (`one of`, `all of`, `either`,
`and`, `or`, `;`, `.`, `,`, parentheses, branch labels, course codes, free text), with
unknown tokens degrading to opaque literals so it never hard-fails.

**20.3%** of prerequisites (628) also carry conditions that are not courses at all — year
standing, instructor permission, grade minimums, "or equivalent" — which cannot be modelled
as a course graph under any parsing strategy. For **8.5%** (264 courses) the prerequisite
contains *no course code whatsoever*, so there is nothing to put in a graph at all; those
render as opaque text and the student is on their own.

### 2.2 Course codes use two conventions, inconsistently

The canonical record carries both `AANB_V 500` (raw) and `AANB 500` (normalized). But
*within prerequisite text*, both conventions appear:

- 1,585 prerequisite strings use `_V`-suffixed codes
- 1,074 use bare codes
- only 2 mix both

So it's a clean per-record split, roughly 60/40 — but with no field indicating which
convention a given record uses. Any join from "course mentioned in a prerequisite" to
"course record" requires normalizing both sides and hoping. (Related trap: stripping `_V`
to normalize is *not* safe against historical snapshots — the previous corpus retained it,
and stripping generated ~1,300 spurious diffs.)

### 2.3 Program pages are untyped

Degree programs are **not a structured content type**. They are generic `node--ubc_page` /
`node--ubc_landing_page` records with freeform HTML in `body`. There is no field
distinguishing an admissions page from a requirements page from an advising page.

We infer a `kind` from title and URL-slug heuristics. It fails often:

- **248 of 576 (43%)** program pages fall through to `other`
- **168 of 198 (85%)** faculty hub pages fall through to `other`

Because degree pages are untyped, we also cannot reliably tell a *program root* from a
*sub-page*, which is why the faculty and degree scrapers need explicit filtering rules to
avoid double-covering the same URLs.

### 2.4 `credits` is polymorphic

2,370 of 9,489 courses (25%) have a credit value that is not a scalar. These are mostly
legitimate — ranges for directed studies and theses — but the field mixes forms freely:
`2-6`, `12-18`, `1.5`, `1.5-3`, `1-9`, `0`. Any consumer must treat credits as a
range type, and nothing in the schema signals that.

### 2.5 Descriptions are absent for ~22% of courses

2,061 courses (21.7%) carry no description text. Some of this is legitimate (certain
graduate cross-listings genuinely have no calendar prose), but because prerequisites live
*inside* the description, **a missing description also means unknowable prerequisites** —
the two failure modes are coupled.

### 2.6 Semantic content jammed into prose fields

Before the JSON:API migration, the HTML scrape routinely captured strings like
"not eligible for Credit/D/Fail" inside whatever field happened to be adjacent. JSON:API
fixed this specific case by exposing `field_course_crdfail` as a proper boolean (now
cleanly populated: 3,850 true / 5,639 false / 0 null). **This is exactly the shape of fix
that works**, and it is the model for what prerequisites need.

---

## Part 3 — What this cost

| Component | Lines | Exists because |
|---|---|---|
| `prereqAst.ts` | 1,417 | prerequisites are prose |
| `scrape_degree_programs.py` | 766 | programs are untyped HTML |
| `scrape_faculties.py` | 425 | hierarchy is breadcrumb-only |
| `scrape_courses.py` | 352 | (now largely JSON:API — the cheap one) |
| **Total** | **~2,960** | |

The contrast is instructive: the *one* entity with a real structured API — courses —
needed the least code, and its scraper got materially simpler after migrating to
`/jsonapi`. Everything expensive is downstream of something being untyped.

---

## Part 4 — What would help, cheapest first

1. **Populate `field_course_prerequisite`.** The field already exists in the content model
   and is empty across all 9,603 courses; the data to fill it already exists as prose in the
   adjacent description field. Failing that, publishing the prerequisite *grammar* as a
   documented spec — without changing any data — would still eliminate most of the
   1,417-line parser and, more importantly, remove the guesswork about whether we are
   parsing it **correctly**. Today we have no way to know when we get it wrong, which for a
   tool that advises students on course eligibility is the risk that actually matters.
2. **Expose the faculty/school/department relationship on program nodes as a field**, so
   hierarchy stops depending on rendered breadcrumbs. This would let two more scrapers move
   to the API and stop fetching HTML entirely.
3. **Give program pages a content type** (or even just a `page_kind` taxonomy term).
   Eliminates 43% of our classification failures outright.
4. **Document `/jsonapi` as a supported public interface**, with a stated rate limit. It is
   currently undocumented, so every consumer discovers it by accident and guesses at
   acceptable usage. A published policy would let us request an appropriate rate instead of
   inferring one.
5. **A read-only course-section/seat feed.** The largest functional unlock, and understandably
   the largest ask — noted for completeness rather than as an expectation.

---

## Note on our crawling conduct

`robots.txt` declares `Crawl-delay: 10` and disallows nothing we access; course pages and
`/jsonapi` are both permitted. We now honour that delay across every scraper, run them
sequentially against the host, cache all responses on disk so re-runs don't re-fetch, and
send an identifying User-Agent carrying a contact email and repository URL. Corpus refreshes
are infrequent — measured in months, not days.

We would rather be doing this against a sanctioned interface than a polite crawler, which is
the substance of the request in Part 4.
