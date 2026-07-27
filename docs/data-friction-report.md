# UBC Vancouver Calendar Data — Where It Breaks Student-Facing Tools

**Author:** Max Chung · **Date:** 2026-07-27
**Context:** Field notes from building [Reodite](https://reodite.com), a student-facing
academic assistant built entirely on UBC's public course calendar.

This is not a wishlist for data we don't have. Every item below is a **specific feature
that is degraded today**, in a tool that is already built and running, because of how
existing published data is shaped. Each section names the tool, the concrete failure a
student sees, and the measurement behind it.

All figures measured against the committed corpus as of 2026-07-27 (9,489 courses /
576 program pages / 198 faculty hub pages). JSON:API observations verified 2026-05-29.

---

## Summary

| Tool | Failure a student actually hits | Scale |
|---|---|---|
| **Prerequisite tree** | Prerequisites must be parsed out of English prose | **0 of 9,603** courses expose a structured prerequisite |
| **Prerequisite tree** | Tree draws an edge to a course that doesn't exist | **526** dead references across **304** courses |
| **Prerequisite tree** | Requirement can't be graphed at all | **8.5%** of prerequisites contain no course code |
| **Degree planner** | Requirement can't be checked off automatically | **33.9%** of all listed degree credits |
| **Degree planner** | Program has no machine-readable requirements at all | **135 of 205** requirement-bearing pages |

---

## 1. Prerequisite Tree

**What it does:** given a course, draws the full transitive tree of what you need first,
with dropdowns for "one of A, B, C" and radio selectors for "Either (a)… or (b)…".

### 1.1 The structured prerequisite field exists and is empty everywhere

Across all **9,603 course nodes** returned by `/jsonapi/node/course`,
`field_course_prerequisite` is populated **zero times**. Meanwhile **2,767** of those
nodes carry a prerequisite inline in `field_course_description`, as prose, after the
literal label `Prerequisite:`.

The field is not sparse — it is universally unpopulated, while the information it was
designed to hold sits a few characters away in a freeform text field.

**Consequence:** the entire tree is built on regex-splitting a description paragraph. A
wording change in a single course description can silently drop a prerequisite edge, and
we have no way to detect that it happened.

### 1.2 The prose encodes real boolean algebra

Across 3,098 courses with prerequisite text (mean 50 chars, max 381):

| Construct | Share |
|---|---|
| `one of …` (disjunction) | 34.5% |
| `and` | 30.7% |
| `or` | 26.6% |
| `all of …` (conjunction) | 16.8% |
| Year-standing conditions | 14.0% |
| `Either (a) … or (b) …` labelled branches | 6.9% |
| Instructor/department permission | 4.0% |
| Numeric grade thresholds | 2.4% |

A real value, in full:

> `Either (a) one of STAT_V 200, STAT_V 203, BIOL_V 300, STAT_V 251, COMM_V 291, ECON_V 325, FRST_V 231, PSYC_V 218, PSYC_V 366 and one of MATH_V 302, STAT_V 302; or (b) DSCI_V 200 and STAT_V 201 and one of MATH_V 302, STAT_V 302; or (c) a score of 65% or higher in one of MATH_V 302, STAT_V 302.`

That is a nested boolean expression with a numeric threshold, written as English. Rendering
it as a tree required a **1,417-line recursive-descent parser** over an ad-hoc token
alphabet, with unknown tokens degrading to opaque literals so it never hard-fails.

We cannot tell you our parser is correct, because there is no specification to check it
against. For a tool that tells students what they're eligible to take, that is the risk
that actually matters — not the engineering cost.

### 1.3 Two course-code conventions, no signal which you'll get

Within prerequisite text: **1,585** strings use `_V`-suffixed codes (`STAT_V 200`),
**1,074** use bare codes (`STAT 200`), and only **2** mix both. A clean ~60/40 per-record
split, with no field indicating which convention a record uses.

Every edge in the tree is a join from "code mentioned in prose" to "course record", so
both sides must be normalized on every lookup. (Normalizing by stripping `_V` is also
unsafe against historical snapshots — the prior corpus retained it, and stripping generated
~1,300 spurious diffs.)

### 1.4 Prerequisites cite courses that no longer exist

**526 course references inside prerequisite text (6.2%) do not resolve to any course in
the calendar.** These affect **304 courses**, each of which renders a tree with at least
one dead edge.

These are not parse errors. `ENGL 112` is cited 16 times, but the ENGL subject has 152
courses and no 112. Likewise `COMM 291` (COMM has 191 courses, no 291), `SPPH 400`,
`PSYC 304`, `STAT 241`. These are retired courses still named as prerequisites of active
ones — a referential integrity gap inside the calendar's own data.

**Consequence:** the student sees a prerequisite they cannot click, cannot look up, and
cannot satisfy, with nothing explaining why.

### 1.5 A fifth of prerequisites aren't course requirements at all

**20.3%** (628) include conditions that are not courses — year standing, instructor
permission, grade minimums, "or equivalent". For **8.5%** (264 courses) the prerequisite
contains **no course code whatsoever**, so there is no graph to draw. Those render as a
block of text and the student is on their own.

---

## 2. Degree Planner

**What it does:** parses a program's year-by-year requirements table into a checklist,
auto-ticking each requirement as the student drags matching courses onto their plan, and
tracking progress toward the degree in credits.

### 2.1 A third of every degree cannot be tracked

The planner classifies each requirement row by one rule: does it name a course code? If
yes it is checkable; if no it is advisory text the student must tick by hand, and it never
counts toward progress automatically.

**33.9% of all listed degree credits fall on the wrong side of that line.**

- Median program: **30.8%** of credits unresolvable
- Worst program: **90.7%**
- **12 programs** where more than half of the degree is unresolvable

So for a typical student, the planner can verify about two-thirds of their degree and must
shrug at the rest.

### 2.2 Because "Electives" is not a defined term

The unresolvable rows are overwhelmingly named requirement *categories* that are never
enumerated. The most frequent, by count of requirement rows:

| Label | Rows |
|---|---|
| Electives | 284 |
| Additional Communication Requirement | 68 |
| Complementary Studies Electives | 32 |
| Elective | 30 |
| Restricted Electives | 29 |
| Unrestricted Electives | 24 |
| Technical Electives | 24 |
| Life Science Selections | 9 |
| Area of Concentration | 6 |

Note that these are **distinct categories with different rules** — "restricted",
"unrestricted", "technical", and "complementary studies" electives are not synonyms, and a
student who confuses them fails to graduate on time. Yet nothing in the published data
distinguishes them beyond the label text.

"Communication Requirement" appears on 56 program pages, but always as a *reference*,
typically a footnote reading:

> `Or equivalent course to fulfill Communication Requirement.`

It is cited as something the reader already knows, and never published as an enumerable set
of satisfying courses. A tool has nothing to resolve. Neither, arguably, does a student.

**What would fix this:** a machine-readable list of which courses satisfy each named
requirement category, per program. This is the single highest-value change in this
document — it converts a third of the planner from decoration into function.

### 2.3 Two-thirds of programs have no parseable requirements at all

Of the **205** program pages that plausibly should carry requirements
(`degree_overview`, `degree_requirements`, `major`, `minor`, `honours`, `specialization`,
`curriculum`), only **70 (34%)** yield a parseable year table.

The rest state their requirements in prose, in tables with a different shape, or by
referring the reader elsewhere. There is no content type or field distinguishing "this page
contains the requirements" from "this page is about admissions" — we infer it from title
and URL-slug heuristics, and **248 of 576 (43%)** program pages fall through to an
`other` bucket we can't classify at all.

**Consequence:** the planner silently supports about a third of programs. For the rest it
falls back to a flat list of course codes mentioned anywhere on the page, which is not a
checklist and cannot track progress.

### 2.4 Per-course fields the planner needs and cannot get

Separate from the requirements problem: the planner places individual courses into a
year/term grid and validates them. These are the per-course fields it asks for, and how
much of the catalogue actually supplies them.

| Field the planner needs | Coverage | What breaks without it |
|---|---|---|
| **Which term(s) the course is offered** | **0.5%** | The planner's entire layout is Term 1–4. A student can place a course in a term it is never offered in and nothing warns them. |
| **Which requirement category the course satisfies** | **0%** | Can't auto-fill "Electives", "Technical Elective", etc. The other half of §2.2. |
| **Credits as a single number** | 75.0% | 25% are ranges (`3-6`, `12-18`, `1.5-3`), so every credit total is approximate. |
| **Registration restrictions** (year standing, program-restricted) | 10.9%, prose only | Can't tell a student they're ineligible to register, only that they lack a prereq. |
| **Exclusions** ("credit will not be given for both X and Y") | ~8.1%, and mixed | The `equivalency` field mostly holds cross-listings (`AFST 256 → HIST 256`), not exclusions. Double-counted credits go undetected. |
| **Corequisites** | 2.9% | Almost certainly under-reported rather than genuinely rare. |
| **Description** | 78.3% | 21.7% have none — and since prerequisites live *inside* the description, a missing description also means unknowable prerequisites. |

The first two are the ones that matter. Term availability is the single missing field that
most limits the planner as a planning tool, and requirement-category tagging is what would
close the gap in §2.2 from the course side rather than the program side.

### 2.5 Requirements arrive as flattened HTML tables

Requirements reach us as alternating lines — a label, then a bare number:

```
Additional Communications Requirement 2
3
Electives 1
12
Total Credits
30
```

Recovering structure means pairing labels with the number that follows, distinguishing a
credit value from a footnote marker (a trailing 1–2 digit run, since course numbers are
always 3 digits), detecting subtotal rows across several phrasings, and merging
continuation lines where `(b) …` appears on its own line as a later branch of the row
above. Each of those is a heuristic that a table-shape change would break silently.

---

## 3. Cross-cutting: the pattern

The three expensive problems have the same shape — **information that the calendar clearly
possesses, published only as rendered prose**:

| Known internally | Published as | Tool that pays |
|---|---|---|
| Prerequisite logic | Sentence inside a description | Prereq tree |
| Which courses satisfy "Electives" | An undefined label | Degree planner |
| Page type (requirements vs admissions) | Untyped `node--ubc_page` | Degree planner |
| Faculty/school hierarchy | Rendered breadcrumbs only | Everything |

The last one is worth a note: `menu_link_content` requires the `administer menu` permission
and returns empty anonymously, and nodes carry no breadcrumb field. So clean faculty names
("The Faculty of Forestry and Environmental Stewardship") are recoverable **only** by
scraping rendered HTML — via the API the best fallback is de-slugging a URL, giving
"Faculty Forestry And Environmental Stewardship".

There is a proof that this is fixable and cheap. `field_course_crdfail` — Credit/D/Fail
eligibility — used to be prose jammed into whatever field sat nearby. It is now a proper
boolean, cleanly populated across the corpus (3,850 true / 5,639 false / 0 null). One field
change deleted an entire class of parsing bug. **Prerequisites need exactly that, and so
does the elective vocabulary.**

---

## 4. Asks, highest value first

1. **Publish which courses satisfy each named requirement category** ("Communication
   Requirement", "Restricted Electives", "Technical Electives"), per program — or tag it
   on the course. Unlocks a third of the degree planner. Nothing else in this document
   comes close in value per unit of effort.
2. **Publish which term(s) each course is offered in.** Currently derivable for 0.5% of
   courses. The planner is built on a term grid it cannot validate against.
3. **Populate `field_course_prerequisite`.** The field exists and is empty; the data exists
   as prose beside it. Failing that, publish the prerequisite *grammar* as a spec so we can
   verify our parser rather than guess.
4. **Give program pages a content type or `page_kind` term.** Eliminates the 43%
   classification failure and lets the planner know which page to read.
5. **Fix or flag retired course references** in prerequisite text (526 known dead edges —
   list available on request).
6. **Expose faculty/school as a field on program nodes**, so hierarchy stops depending on
   rendered breadcrumbs.
7. **Document `/jsonapi` as a supported interface with a stated rate limit.** It is
   currently undocumented, so every consumer discovers it by accident and guesses at
   acceptable usage.

---

## Note on our crawling conduct

`robots.txt` declares `Crawl-delay: 10` and disallows nothing we access; course pages and
`/jsonapi` are both permitted. We honour that delay across every scraper, run them
sequentially against the host, cache all responses on disk so re-runs don't re-fetch, and
send an identifying User-Agent carrying a contact email and repository URL. Corpus
refreshes are measured in months, not days.

We would rather be building against a sanctioned interface than a polite crawler, which is
the substance of the asks above.
