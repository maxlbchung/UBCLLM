"""One-off: extract structured per-category requirements from degree_programs.json
into web/public/data/program_requirements.json (Track B overlay).

Quality bar: when in doubt, OMIT. Better few high-confidence entries than many sloppy ones.

NOT a permanent pipeline step. NOT committed to the repo.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from collections import OrderedDict

ROOT = Path(__file__).resolve().parent.parent
SCRAPER_OUT = ROOT / "scraper" / "output" / "degree_programs.json"
COURSES_OUT = ROOT / "scraper" / "output" / "courses.json"
WEB_OUT = ROOT / "web" / "public" / "data" / "program_requirements.json"

ALLOWED_KINDS = {
    "major",
    "honours",
    "degree_requirements",
    "degree_overview",
    "minor",
    "specialization",
    "dual_degree",
}
ALLOWED_LEVELS = {"undergraduate", "certificate"}


# --- Course-code normalisation --------------------------------------------

def load_course_codes() -> set[str]:
    data = json.loads(COURSES_OUT.read_text(encoding="utf-8"))
    return {c["code"] for c in data}


COURSES: set[str] = set()
# index of subject -> sorted list of numeric numbers (as strings) for quick lookup
SUBJECT_NUMBERS: dict[str, set[str]] = {}


def _index_subjects() -> None:
    for code in COURSES:
        try:
            subj, num = code.split(" ", 1)
        except ValueError:
            continue
        SUBJECT_NUMBERS.setdefault(subj, set()).add(num)


def canon(subject: str, number: str) -> str | None:
    """Return canonical 'SUBJ NUM' if it exists in courses.json, else None.

    Falls back to stripping a single-letter section suffix ("489C" -> "489")
    when the literal code isn't in the catalog — UBC routinely lists letter-
    suffixed section variants in prose for courses that exist as a single
    base-number entry in the calendar.
    """
    subj = subject.upper().replace("_V", "").strip()
    num = number.strip().upper()
    code = f"{subj} {num}"
    if code in COURSES:
        return code
    # Try without trailing letter (e.g. "489C" -> "489")
    if num and num[-1].isalpha():
        stripped = num.rstrip("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        if stripped:
            alt = f"{subj} {stripped}"
            if alt in COURSES:
                return alt
    return None


# --- Tokenisation of an inline phrase --------------------------------------

# Matches things like:
#   CPSC_V 110
#   MATH_V 100
#   ENGL 100              (already stripped)
#   COMM_V 191
SUBJECT_RE = r"[A-Z]{2,4}(?:_V)?"
NUM_RE = r"\d{3}[A-Z]?"

# Token that introduces a subject-and-number: SUBJ_V 110
SUBJ_NUM_RE = re.compile(rf"\b({SUBJECT_RE})\s+({NUM_RE})\b")
# Trailing course number (e.g. "or 102" after a SUBJ_V 100). We bind these to the
# most recent subject when expanding "MATH_V 100 or 102 or 104".
BARE_NUM_RE = re.compile(rf"\b({NUM_RE})\b")

# Inline references to credit categories — "12 credits of CPSC_V courses
# numbered 300 or higher" → subject_pattern="CPSC 3" plus
# subject_pattern="CPSC 4". For our (simpler) overlay we collapse the
# "or higher" into a single broad pattern at the lowest hundred shown.
CREDITS_OF_PATTERN_RE = re.compile(
    r"(\d+)\s+credits?\s+of\s+([A-Z]{2,4})(?:_V)?\s+courses?\s+numbered\s+(\d{3})\s+or\s+higher",
    re.IGNORECASE,
)


def extract_codes_from_phrase(phrase: str) -> list[str]:
    """Pull every 'SUBJ_V NUM' (or already-stripped 'SUBJ NUM') from a phrase,
    expanding 'SUBJ 100 or 102 or 104' into [SUBJ 100, SUBJ 102, SUBJ 104]."""
    out: list[str] = []
    last_subject: str | None = None
    # Walk the string from left to right, alternately matching SUBJ_NUM and
    # bare NUM tokens. We keep this simple by scanning positions.
    pos = 0
    while pos < len(phrase):
        sn = SUBJ_NUM_RE.search(phrase, pos)
        bn = BARE_NUM_RE.search(phrase, pos)
        if sn and (not bn or sn.start() <= bn.start()):
            subj = sn.group(1)
            num = sn.group(2)
            code = canon(subj, num)
            if code:
                out.append(code)
            last_subject = subj.replace("_V", "")
            pos = sn.end()
        elif bn:
            num = bn.group(1)
            if last_subject:
                code = canon(last_subject, num)
                if code and code not in out:
                    out.append(code)
            pos = bn.end()
        else:
            break
    return out


# --- Year-block extractor ---------------------------------------------------

YEAR_HEADER_RE = re.compile(
    r"^(First|Second|Third|Fourth|Fifth)\s+Year\s*$",
    re.IGNORECASE,
)
TOTAL_RE = re.compile(r"^Total\s*/?\s*[Cc]redits?\s*:?\s*$")
INT_RE = re.compile(r"^\d+(?:/\d+)*$")


def parse_year_blocks(text: str) -> list[tuple[str, int, list[tuple[str, int]]]]:
    """Find blocks shaped like::

        First Year
        ECON_V 101/102
        6
        COMM_V 101
        3
        ...
        Total Credits
        30

    Returns a list of (year_label, total_credits, [(phrase, credits), ...]).
    """
    lines = [ln.strip() for ln in text.splitlines()]
    blocks: list[tuple[str, int, list[tuple[str, int]]]] = []
    i = 0
    while i < len(lines):
        m = YEAR_HEADER_RE.match(lines[i])
        if not m:
            i += 1
            continue
        year_label = m.group(0).title()
        rows: list[tuple[str, int]] = []
        total_credits = 0
        j = i + 1
        # Collect (phrase, credits) pairs until we hit "Total Credits" + value
        while j < len(lines):
            ln = lines[j]
            if not ln:
                j += 1
                continue
            if YEAR_HEADER_RE.match(ln):
                break
            if TOTAL_RE.match(ln):
                # Next non-empty integer-ish line is total
                k = j + 1
                while k < len(lines) and not lines[k]:
                    k += 1
                if k < len(lines) and INT_RE.match(lines[k]):
                    val = lines[k].split("/")[0]
                    try:
                        total_credits = int(val)
                    except ValueError:
                        pass
                    j = k + 1
                else:
                    j += 1
                break
            # Otherwise expect a "phrase" line followed by a credit-number line
            phrase = ln
            k = j + 1
            while k < len(lines) and not lines[k]:
                k += 1
            if k >= len(lines):
                break
            num_line = lines[k]
            # Credit line examples: "3", "4/3", "30/31/32" (year totals — not
            # row-level — so credit lines are typically small)
            if INT_RE.match(num_line):
                # Take the first part of an "a/b" form (lowest-credit alternative)
                first = num_line.split("/")[0]
                try:
                    credits = int(first)
                except ValueError:
                    credits = 0
                if 1 <= credits <= 20:
                    rows.append((phrase, credits))
                j = k + 1
            else:
                # Looks like a continuation phrase; bail out of this row pairing.
                j = k
        if rows:
            blocks.append((year_label, total_credits, rows))
        i = j if j > i else i + 1
    return blocks


# --- Build categories from year blocks --------------------------------------

# Phrases that signal we should NOT try to extract a course code from a row
# (it's an elective bucket, not a specific course). We keep them as
# subject_pattern when possible.
ELECTIVE_KEYWORDS = (
    "elective",
    "electives",
    "restricted",
    "approved",
    "options requirements",
    "option requirements",
    "non-commerce",
    "course",
)


def row_to_options(phrase: str, credits: int) -> list[dict] | None:
    """Convert a 'phrase / credits' row into a list of category options.

    Returns ``None`` when the row is too vague to encode (e.g. 'Electives').
    """
    p = phrase.strip()
    low = p.lower()

    # --- Bucket: bare 'Elective(s)' / 'Total Credits' row — skip ---
    if low in {"elective", "electives", "total credits", "total"}:
        return None

    # --- "12 credits of CPSC_V courses numbered 300 or higher" -> subject_pattern
    m = CREDITS_OF_PATTERN_RE.search(p)
    if m:
        subj = m.group(2).upper()
        bucket = m.group(3)[0]  # '3' for 300-level
        # Only emit if the subject actually exists
        if subj in SUBJECT_NUMBERS:
            return [{"subject_pattern": f"{subj} {bucket}"}]
        return None

    # --- General "X credits ..." catchall when no codes resolve — skip ---
    if any(k in low for k in ELECTIVE_KEYWORDS) and not SUBJ_NUM_RE.search(p):
        return None

    # --- Otherwise extract code(s) from the phrase ---
    codes = extract_codes_from_phrase(p)
    if not codes:
        return None

    # Decide whether the phrase implies "and" (all of them) or "or" (pick one).
    # We can't perfectly tell, but the credit field gives us a strong hint:
    #   - "A and B" + credits = 6 (or whatever sum) -> all options required
    #   - "A or B"  + credits = 3 (one course of value)  -> pick one
    # For overlay purposes, each "option" is an acceptable course to satisfy
    # the category. So:
    #   - "or" form: emit all codes as options of one category with credits = row credits
    #   - "and" form: this row actually represents *several* required courses.
    #     We model that by giving each its own atomic category contribution.
    #     To keep things simple, we expose them all as options but with
    #     credit_value = row credits / len(codes) when divisible. The UI
    #     treats options as "any of these completes the category" — so
    #     conjunction over multiple required courses is *not* well-encoded.
    #     In that case we still emit ONE option per code so progress shows.

    has_or = bool(re.search(r"\bor\b", low))
    has_and = bool(re.search(r"\band\b", low))

    if has_or and not has_and and len(codes) > 1:
        # disjunction — emit all codes as alternatives
        return [{"code": c} for c in codes]

    # Default: every code mentioned is a target. Most year-block rows mention a
    # single code (with possibly a note in parens). When multiple codes appear
    # under 'and', they're all required. We model that by emitting one
    # option per code so the user can check them off (the UI computes
    # credits-earned as a sum of distinct matched options × default course
    # credits, so this still produces sensible totals).
    return [{"code": c} for c in codes]


def build_year_categories(
    blocks: list[tuple[str, int, list[tuple[str, int]]]],
) -> list[dict]:
    cats: list[dict] = []
    for year, total, rows in blocks:
        opts: list[dict] = []
        seen: set[str] = set()
        elective_credits = 0  # credits absorbed by generic "Electives" rows
        for phrase, credits in rows:
            row_opts = row_to_options(phrase, credits)
            if row_opts is None:
                low = phrase.strip().lower()
                if "elective" in low and credits > 0:
                    elective_credits += credits
                continue
            for o in row_opts:
                key = o.get("code") or f"P:{o.get('subject_pattern', '')}"
                if key in seen:
                    continue
                seen.add(key)
                opts.append(o)
        if not opts:
            continue
        # If we have a stated year total, use it. Otherwise derive from rows
        # that resolved.
        credits_required = total if total else sum(c for _, c in rows)
        cat: dict = {
            "name": f"{year} courses",
            "credits_required": credits_required,
            "options": opts,
        }
        if elective_credits:
            cat["notes"] = f"plus {elective_credits} credits of electives"
        cats.append(cat)
    return cats


# --- Total program credits --------------------------------------------------

TOTAL_PROG_RE = re.compile(
    r"\b(?:minimum\s+of\s+|complete\s+(?:a\s+)?(?:minimum\s+of\s+)?|total\s+of\s+)?(\d{2,3})\s+credits?\b",
    re.IGNORECASE,
)


def infer_total_credits(text: str, year_blocks_total: int, level: str) -> int | None:
    """Try to find the program's stated total credit count.

    Resolution order:
      1. ``Program Total\\nN`` literal anchor (highest confidence)
      2. ``minimum of N credits`` / ``total of N credits`` phrases in the
         intro paragraph (before the first '###' section), filtered to a
         level-appropriate band (≥60 for undergrad, ≥9 for cert).
      3. Summed year-block totals if they look plausible (30-200).
    """
    # 1. Explicit "Program Total\nN" or "Program Total: N"
    m = re.search(
        r"Program\s+Total\s*[:\n]\s*(\d{2,3})\b", text, re.IGNORECASE,
    )
    if m:
        n = int(m.group(1))
        if 6 <= n <= 200:
            return n

    # 2. Intro-paragraph phrases
    intro = text.split("\n###", 1)[0]
    candidates: list[int] = []
    for m in re.finditer(
        r"(?:minimum\s+of\s+|total\s+of\s+|complete\s+(?:a\s+minimum\s+of\s+|a\s+total\s+of\s+)?)?(\d{2,3})\s+credits?",
        intro,
        re.IGNORECASE,
    ):
        n = int(m.group(1))
        if 6 <= n <= 200:
            candidates.append(n)

    lo, hi = (9, 90) if level == "certificate" else (60, 200)
    in_band = [c for c in candidates if lo <= c <= hi]
    if in_band:
        return max(in_band)

    # 3. Summed year-block totals
    if 30 <= year_blocks_total <= 200:
        return year_blocks_total
    if candidates:
        return candidates[0]
    return None


# --- Year-less course block (looks like a year block, but no header) --------


def parse_unanchored_blocks(text: str) -> list[tuple[int, list[tuple[str, int]]]]:
    """When degree_requirements pages list course/credits rows back-to-back
    without explicit 'First Year' anchors, we still want to capture them. We
    walk the lines, detect (phrase, credit_int) pairs, and break them apart
    when we hit a 'Total Credits / N' marker.
    """
    lines = [ln.strip() for ln in text.splitlines()]
    blocks: list[tuple[int, list[tuple[str, int]]]] = []
    rows: list[tuple[str, int]] = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        if not ln:
            i += 1
            continue
        # Stop blocks at section headers
        if ln.startswith("#"):
            if rows:
                blocks.append((0, rows))
                rows = []
            i += 1
            continue
        if TOTAL_RE.match(ln):
            # Next non-empty int line is the total
            k = i + 1
            while k < len(lines) and not lines[k]:
                k += 1
            if k < len(lines) and INT_RE.match(lines[k]):
                try:
                    total = int(lines[k].split("/")[0])
                except ValueError:
                    total = 0
                if rows:
                    blocks.append((total, rows))
                rows = []
                i = k + 1
                continue
            i += 1
            continue
        # Heuristic: phrase must mention either a subject code, "credits",
        # "credit of", "Elective", or "Any ... courses" — otherwise it's
        # narrative prose.
        has_signal = bool(
            SUBJ_NUM_RE.search(ln)
            or "elective" in ln.lower()
            or "credits" in ln.lower()
            or re.search(r"\bAny\s+\d", ln, re.IGNORECASE)
            or re.search(r"\bone\s+of\b", ln, re.IGNORECASE)
        )
        # Plausibly a phrase line — look for an int line after it
        k = i + 1
        while k < len(lines) and not lines[k]:
            k += 1
        if k < len(lines) and INT_RE.match(lines[k]) and has_signal:
            try:
                credits = int(lines[k].split("/")[0])
            except ValueError:
                credits = 0
            if 1 <= credits <= 20:
                rows.append((ln, credits))
                i = k + 1
                continue
        # Non-row line — flush block if it grew big enough
        if rows and len(rows) >= 3 and not has_signal:
            blocks.append((0, rows))
            rows = []
        i += 1
    if rows:
        blocks.append((0, rows))
    # Keep only blocks of meaningful size (>= 3 rows) to avoid noise.
    return [b for b in blocks if len(b[1]) >= 3]


def build_unanchored_categories(
    blocks: list[tuple[int, list[tuple[str, int]]]],
) -> list[dict]:
    cats: list[dict] = []
    for n, (total, rows) in enumerate(blocks, 1):
        opts: list[dict] = []
        seen: set[str] = set()
        elective_credits = 0
        for phrase, credits in rows:
            row_opts = row_to_options(phrase, credits)
            if row_opts is None:
                if "elective" in phrase.lower() and credits > 0:
                    elective_credits += credits
                continue
            for o in row_opts:
                key = o.get("code") or f"P:{o.get('subject_pattern', '')}"
                if key in seen:
                    continue
                seen.add(key)
                opts.append(o)
        if not opts:
            continue
        credits_required = total if total else sum(c for _, c in rows)
        ordinal = ("First", "Second", "Third", "Fourth", "Fifth", "Sixth")
        name = (
            f"{ordinal[n - 1]} block courses"
            if n - 1 < len(ordinal)
            else f"Block {n}"
        )
        cat: dict = {
            "name": name,
            "credits_required": credits_required,
            "options": opts,
        }
        if elective_credits:
            cat["notes"] = f"plus {elective_credits} credits of electives"
        cats.append(cat)
    return cats


# --- Certificate / minor pattern --------------------------------------------

CERT_REQS_HEADER_RE = re.compile(
    r"###\s+(Certificate|Minor)\s+Requirements", re.IGNORECASE
)
TOTAL_OF_N_CREDITS_RE = re.compile(
    r"total\s+of\s+(\d{1,3})\s+credits?", re.IGNORECASE
)


def parse_cert_or_minor(text: str) -> tuple[int, list[dict]] | None:
    """Handle the very common cert/minor pattern::

        Students must complete a total of 15 credits, consisting of:
        ECED_V 405
        3
        Any 400-level ECED_V courses
        12
        Total Credits
        15
    """
    # The cert/minor block typically follows a header; but for robustness we
    # just look for the "total of N credits" anchor and parse until "Total
    # Credits" follower.
    m_total = TOTAL_OF_N_CREDITS_RE.search(text)
    if not m_total:
        return None
    total = int(m_total.group(1))
    # Slice the text from the match forward.
    snippet = text[m_total.end() :]
    # Stop snippet at "### Application" or "### " headers
    cut = re.search(r"\n###\s", snippet)
    if cut:
        snippet = snippet[: cut.start()]
    lines = [ln.strip() for ln in snippet.splitlines() if ln.strip()]

    opts: list[dict] = []
    seen: set[str] = set()
    notes: list[str] = []

    def _add(opt: dict) -> None:
        key = opt.get("code") or f"P:{opt.get('subject_pattern', '')}"
        if key in seen:
            return
        seen.add(key)
        opts.append(opt)

    i = 0
    while i < len(lines):
        ln = lines[i]
        if TOTAL_RE.match(ln):
            break
        # Look ahead for a numeric credit line
        if i + 1 < len(lines) and INT_RE.match(lines[i + 1]):
            phrase = ln
            credits = int(lines[i + 1].split("/")[0])
            row_opts = row_to_options(phrase, credits)
            if row_opts is None:
                # Try to capture "Any 400-level ECED_V courses" → subject_pattern
                m = re.search(
                    r"Any\s+(\d{3}|\d)\s*-?level\s+([A-Z]{2,4})(?:_V)?\s+courses?",
                    phrase,
                    re.IGNORECASE,
                )
                if m:
                    subj = m.group(2).upper()
                    num_prefix = m.group(1)[0] if len(m.group(1)) >= 1 else m.group(1)
                    if subj in SUBJECT_NUMBERS:
                        _add(
                            {
                                "subject_pattern": f"{subj} {num_prefix}",
                                "credit_value": credits,
                            }
                        )
                else:
                    notes.append(phrase)
            else:
                # Distribute by attaching credit_value when row has a single
                # explicit code (so progress maths is correct).
                if len(row_opts) == 1 and "code" in row_opts[0]:
                    o = dict(row_opts[0])
                    o["credit_value"] = credits
                    _add(o)
                else:
                    for o in row_opts:
                        _add(o)
            i += 2
        else:
            # Bare phrase (no credits) — skip
            i += 1
    if not opts:
        return None
    cat = {
        "name": "Required courses",
        "credits_required": total,
        "options": opts,
    }
    if notes:
        cat["notes"] = "; ".join(notes[:2])
    return total, [cat]


# --- Inline-prose extractor ("consists of A, B, C; and one of D, E") --------


def parse_inline_consists_of(text: str) -> tuple[int | None, list[dict]] | None:
    """Match prose like::

        The program consists of COMR_V 329, 457, 465, 473, 493; and one of
        COMR_V 398, or 458.

    Pull the listed required courses + the "one of" disjunction as options.
    """
    # Anchor on "consists of" or "The program consists of:"
    m = re.search(
        r"(?:program|minor|certificate)\s+(?:will\s+)?consists?\s+of\s*[:\s]+([^\n]+(?:\n[^\n#]+){0,4})",
        text,
        re.IGNORECASE,
    )
    if not m:
        return None
    body = m.group(1).strip()
    # Trim trailing period and anything past it (next sentence).
    body = re.split(r"(?<=[.])\s+[A-Z]", body, maxsplit=1)[0]
    # Required codes are everything up to the first "; and one of" / "; one of"
    parts = re.split(r";?\s*(?:and\s+)?one\s+of\s+", body, maxsplit=1, flags=re.IGNORECASE)
    required = parts[0]
    disjunctions = parts[1] if len(parts) > 1 else ""

    req_codes = extract_codes_from_phrase(required)
    disj_codes = extract_codes_from_phrase(disjunctions) if disjunctions else []

    if not req_codes:
        return None

    opts: list[dict] = []
    seen: set[str] = set()
    for c in req_codes:
        if c not in seen:
            opts.append({"code": c})
            seen.add(c)
    # Disjunction options share one slot — but since the overlay can't model
    # "pick one of these" inside a larger category, we still list them all as
    # options and rely on a note for context.
    for c in disj_codes:
        if c not in seen:
            opts.append({"code": c})
            seen.add(c)

    if len(opts) < 2:
        return None

    cat: dict = {
        "name": "Required courses",
        "credits_required": len(req_codes) * 3 + (3 if disj_codes else 0),
        "options": opts,
    }
    if disj_codes:
        cat["notes"] = "Pick one from the alternates at the end."
    return None, [cat]


# --- Top-level driver -------------------------------------------------------

def process_record(record: dict) -> dict | None:
    text = record.get("text") or ""
    if len(text) < 60:
        return None

    kind = record.get("kind", "")
    level = record.get("level", "")
    is_cert_or_minor = kind == "minor" or level == "certificate"

    blocks: list[tuple[str, int, list[tuple[str, int]]]] = []
    categories: list[dict] = []
    cert_result = None

    # For minors/certificates, try the dedicated cert/minor parser FIRST —
    # it gives better category names ("Required courses") and attaches
    # credit_value overrides to options.
    if is_cert_or_minor:
        cert_result = parse_cert_or_minor(text)
        if cert_result:
            _, cats = cert_result
            categories = cats

    if not categories:
        blocks = parse_year_blocks(text)
        # Pages that repeat year headers (e.g. "First Year" twice for a dual
        # major) describe multiple parallel paths — collapsing them into a
        # single ordered category list would misleadingly inflate totals.
        # Skip in those cases; the prose-mode fallback handles them fine.
        labels = [b[0] for b in blocks]
        if blocks and len(labels) == len(set(labels)):
            categories = build_year_categories(blocks)
        else:
            blocks = []

    if not categories:
        # Year-less blocks (e.g. degree_requirements that just lists rows)
        unb = parse_unanchored_blocks(text)
        if unb:
            # Skip pages with too many distinct blocks — typically an overview
            # listing multiple specializations / paths, where exposing every
            # block would mislead the UI's progress totals. Undergraduate
            # programs are typically 4 years; allow some headroom (6 = 5-year
            # programs, 6-block programs like Midwifery's term-by-term layout)
            # but bail beyond that.
            if len(unb) > 6:
                unb = []
        if unb:
            categories = build_unanchored_categories(unb)
            if categories:
                # Use the summed totals from the unanchored blocks for total_credits
                blocks = [("", t, rows) for t, rows in unb]

    if not categories and not is_cert_or_minor:
        # Last-resort cert/minor pattern for non-cert/minor records
        cert_result = parse_cert_or_minor(text)
        if cert_result:
            _, cats = cert_result
            categories = cats

    if not categories:
        inline_result = parse_inline_consists_of(text)
        if inline_result:
            _, cats = inline_result
            categories = cats

    if not categories:
        return None

    # Compute total credits.
    year_total = sum(b[1] for b in blocks) if blocks else 0
    total = None
    if cert_result:
        total = cert_result[0]
    if total is None:
        total = infer_total_credits(text, year_total, level)

    out: dict = {"program_url": record["url"], "categories": categories}
    if total:
        out["total_credits"] = total
    return out


def merge_and_write(path: Path, new_entries: dict) -> None:
    existing: OrderedDict[str, dict] = OrderedDict()
    if path.exists():
        try:
            existing = OrderedDict(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            existing = OrderedDict()
    for k, v in new_entries.items():
        existing[k] = v
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(existing, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    global COURSES
    COURSES = load_course_codes()
    _index_subjects()
    records = json.loads(SCRAPER_OUT.read_text(encoding="utf-8"))
    filtered = [
        r
        for r in records
        if r.get("kind") in ALLOWED_KINDS and r.get("level") in ALLOWED_LEVELS
    ]
    filtered.sort(key=lambda r: ((r.get("faculty") or ""), (r.get("title") or "")))

    print(f"Filtered to {len(filtered)} candidate records.")

    # Reset the overlay before we start a fresh extraction run so the file
    # represents the latest pass only. (Incremental flush is still useful for
    # observability during the run.)
    if WEB_OUT.exists():
        WEB_OUT.unlink()

    skipped_reasons: dict[str, int] = {}
    produced = 0
    pending: dict[str, dict] = {}
    flush_every = 10

    for n, r in enumerate(filtered, 1):
        try:
            entry = process_record(r)
        except Exception as exc:
            entry = None
            skipped_reasons.setdefault(f"exception:{type(exc).__name__}", 0)
            skipped_reasons[f"exception:{type(exc).__name__}"] += 1
        if entry:
            pending[r["url"]] = entry
            produced += 1
        else:
            reason = (
                "no year blocks AND no cert pattern matched"
                if (r.get("text") and len(r["text"]) > 60)
                else "text too short"
            )
            skipped_reasons[reason] = skipped_reasons.get(reason, 0) + 1
        if n % flush_every == 0 and pending:
            merge_and_write(WEB_OUT, pending)
            pending = {}
    if pending:
        merge_and_write(WEB_OUT, pending)

    print(f"\nProcessed: {len(filtered)}")
    print(f"Produced:  {produced}")
    print(f"Skipped:   {len(filtered) - produced}")
    for reason, count in sorted(skipped_reasons.items(), key=lambda x: -x[1]):
        print(f"  {count:>4}  {reason}")


if __name__ == "__main__":
    main()
