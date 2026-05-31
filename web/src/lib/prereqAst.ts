// Boolean-prerequisite parser. Turns a free-text UBC prereq string like
//
//   "BIOL 204 and one of BIOL 260, BIOL 361. And 3rd year standing"
//
// into a small AST that PrereqTree can render with selectable disjunction
// groups. The grammar handles "one of …", "all of …", "either (a) … or (b) …",
// and the conjunction joiners "and" / ";" / ".". Anything else (class-standing
// text, grade thresholds, instructor consent, etc.) collapses into a Literal
// node that the renderer drops at the top level and shows as a non-clickable
// option inside disjunctions.

export type Expr =
  | { kind: 'and'; children: Expr[] }
  | { kind: 'or'; ui: 'dropdown' | 'stacked'; children: Expr[] }
  | { kind: 'code'; code: string }
  | { kind: 'literal'; text: string }
  // Flattened either-branch: the source said something like
  // "a score of 68% or higher in MATH 226" or "a score of 80% or higher
  // in one of MATH 101, MATH 103". We display the verbatim prose
  // (`text`) on the radio sub-block; `subExpr` carries whatever
  // structure the branch contained (a single Code, an Or-dropdown, an
  // And of mixed atoms, …), and the renderer walks it for upstream
  // edges/blocks. Only produced by the labeled-either branch parser
  // when a bare OR appears mid-branch.
  | { kind: 'flattened'; text: string; subExpr: Expr | null }
  // Soft / "optional" wrapper: the inner subtree was extracted from a
  // recommendation tail like ". <X> is recommended" / ". <X, Y> are
  // recommended" / ". <X> strongly recommended". The renderer styles
  // edges from the wrapped subtree's top-level blocks to their target
  // as dotted lines with an "optional" label. Children deeper in the
  // tree (transitive prereqs of an optional course) are NOT marked
  // soft — once you opt in to taking the recommended course, its own
  // prereqs become required for that path.
  | { kind: 'soft'; child: Expr }

// Course-code canonicalization — same shape `extractCourseCodes` in
// retrieve.ts produces ("CPSC 110", uppercased, no `_V` suffix). Keys built
// from this string are looked up in the same `getCourseIndex()` Map.
const CODE_RE = /^([A-Z]{3,5})(?:_V)?\s*(\d{2,4}[A-Z]?)\b/i

function canonicalizeCode(subject: string, number: string): string {
  return `${subject.toUpperCase()} ${number.toUpperCase()}`
}

// ---------- Tokenizer ----------

// Tokens carry their start offset in the input so the parser can slice the
// original text back out (used by the trailing-drain fallback in `parse()`
// to capture any prose left over after the top-level and_expr exits).
type TokenBase = { start: number }
type Token = TokenBase &
  (
    | { type: 'CODE'; value: string }
    | { type: 'ONE_OF' }
    | { type: 'ALL_OF' }
    | { type: 'EITHER' }
    | { type: 'AND' }
    | { type: 'OR' }
    | { type: 'LABEL' /* (a), (b), … */ }
    | { type: 'LPAREN' }
    | { type: 'RPAREN' }
    | { type: 'COMMA' }
    | { type: 'SEMI' /* ; */ }
    | { type: 'DOT' /* . */ }
    | { type: 'TEXT'; value: string }
  )

// Words/symbols the lexer treats as token boundaries. Anything else
// accumulates into a TEXT token. The `make` factories return the type
// tag only; the lexer wraps the result with the matched `start` offset
// before pushing.
type KwToken =
  | { type: 'ONE_OF' }
  | { type: 'ALL_OF' }
  | { type: 'EITHER' }
  | { type: 'AND' }
  | { type: 'OR' }
const KW_PATTERNS: Array<{ re: RegExp; make: () => KwToken }> = [
  { re: /^one\s+of\b/i, make: () => ({ type: 'ONE_OF' }) },
  { re: /^all\s+of\b/i, make: () => ({ type: 'ALL_OF' }) },
  { re: /^either\b/i, make: () => ({ type: 'EITHER' }) },
  { re: /^and\b/i, make: () => ({ type: 'AND' }) },
  { re: /^or\b/i, make: () => ({ type: 'OR' }) },
]

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let textBuf = ''
  // Position of the first character in the current text run. -1 when
  // textBuf is empty. Whitespace inside a run is preserved (so multi-word
  // text tokens like "Pre-calculus 12" stay intact); leading whitespace
  // is skipped so textStart always points at a real character.
  let textStart = -1
  // Subject of the most recent CODE token, used to expand bare-numeric
  // continuations like "MATH 100, 110, 120" into CODE MATH 110, CODE MATH
  // 120. Updated whenever a real CODE is emitted; cleared on DOT
  // (sentence boundary) so cross-clause numerics don't bleed.
  let lastCodeSubject: string | null = null
  // Type of the most recently emitted token. Used to gate the bare-number
  // expansion to list-context preceding tokens (COMMA / OR / AND) — a
  // bare number after a SEMI / DOT / RPAREN / start-of-input is more
  // likely "30 credits" than "CODE 30", so we leave it as text.
  let lastTokenType: Token['type'] | null = null

  const pushToken = (t: Token) => {
    tokens.push(t)
    lastTokenType = t.type
    if (t.type === 'CODE') {
      const space = t.value.indexOf(' ')
      if (space > 0) lastCodeSubject = t.value.slice(0, space)
    } else if (t.type === 'DOT') {
      // Sentence boundary — drop the inherited subject so prose like
      // "Take MATH 100. 30 credits required" doesn't turn "30" into
      // CODE MATH 30.
      lastCodeSubject = null
    }
  }

  const flushText = () => {
    const trimmed = textBuf.replace(/\s+$/, '')
    if (trimmed) {
      pushToken({ type: 'TEXT', value: trimmed, start: textStart })
    }
    textBuf = ''
    textStart = -1
  }
  const beginTextChar = (ch: string) => {
    if (!textBuf) textStart = i
    textBuf += ch
  }

  while (i < input.length) {
    const ch = input[i]
    if (/\s/.test(ch)) {
      // Only retain whitespace inside an in-progress text run; skip
      // leading whitespace so textStart stays anchored on the first real
      // character of the run.
      if (textBuf) textBuf += ch
      i++
      continue
    }
    // Context-dependent handling of ":" / "[" / "]":
    //   - When NO text run is in progress (textBuf empty): treat as a
    //     structural separator — flush (no-op) and push no token. This
    //     keeps "All of:" / "One of:" parsing correctly (the colon
    //     between the keyword and the items doesn't become a literal
    //     item inside the group), and lets "Required: BIOL 121" still
    //     emit CODE BIOL 121 after the colon flushes the "Required"
    //     text run.
    //   - When a text run IS in progress: append the character verbatim
    //     so it survives into the literal block. The user wants prose
    //     like "credit exclusion: https://…" or "list [ https://… ]" to
    //     show the punctuation in the rendered literal, not silently
    //     swallow it. The colon-as-content path is the common case for
    //     mid-clause "X: Y" prose; the colon-as-separator path is only
    //     hit immediately after a keyword or other structural token
    //     emitted a flush.
    if (ch === ':' || ch === '[' || ch === ']') {
      if (textBuf) {
        textBuf += ch
      } else {
        flushText()
      }
      i++
      continue
    }

    // URL absorber: when at the start of an "http(s)://…" substring,
    // consume the entire URL as one text chunk so its internal "." /
    // "and" / "or" don't fragment it across DOT / AND / OR tokens (UBC's
    // credit-exclusion-list URLs hit all three). The URL ends at the
    // first whitespace, bracket, paren, or angle bracket; trailing
    // punctuation that isn't part of the URL stays for the next loop
    // iteration to handle. The chunk goes into textBuf (starting a new
    // run if needed) so it merges naturally with surrounding prose, and
    // CourseNode / DisjunctionNode pick it back out via the
    // `renderTextWithLinks` helper to render as a clickable hyperlink.
    if (ch === 'h' || ch === 'H') {
      const urlMatch = input.slice(i).match(/^https?:\/\/[^\s<>\]\[)]+/i)
      if (urlMatch) {
        beginTextChar(urlMatch[0][0])
        for (let k = 1; k < urlMatch[0].length; k++) textBuf += urlMatch[0][k]
        i += urlMatch[0].length
        continue
      }
    }

    // Branch label: "(a)", "(b)", … — only single ASCII letter inside parens.
    // Anything else inside parens is a real LPAREN.
    const labelMatch = input.slice(i).match(/^\(\s*([a-z])\s*\)/i)
    if (labelMatch) {
      flushText()
      pushToken({ type: 'LABEL', start: i })
      i += labelMatch[0].length
      continue
    }
    // Loose label: "a)", "b)", … without leading paren. Some prereq
    // strings (e.g. MATH 121: "Either a) a score of …, b) …") use this
    // shorthand. Gated on word-start so we don't mis-tokenize a random
    // ")" inside prose like "yeah)" — must be preceded by whitespace,
    // a comma, semicolon, period, or be at position 0.
    const looseLabelStart = i === 0 || /[\s,;.]/.test(input[i - 1])
    if (looseLabelStart) {
      const looseMatch = input.slice(i).match(/^([a-z])\s*\)/i)
      if (looseMatch) {
        flushText()
        pushToken({ type: 'LABEL', start: i })
        i += looseMatch[0].length
        continue
      }
    }

    if (ch === '(') {
      flushText()
      pushToken({ type: 'LPAREN', start: i })
      i++
      continue
    }
    if (ch === ')') {
      flushText()
      pushToken({ type: 'RPAREN', start: i })
      i++
      continue
    }
    if (ch === ',') {
      flushText()
      pushToken({ type: 'COMMA', start: i })
      i++
      continue
    }
    if (ch === ';') {
      flushText()
      pushToken({ type: 'SEMI', start: i })
      i++
      continue
    }
    if (ch === '.') {
      flushText()
      pushToken({ type: 'DOT', start: i })
      i++
      continue
    }

    // Word-boundary guard: only attempt CODE / keyword matches when we're
    // at the start of a word. Without this, "or" inside "for"/"more"/etc.
    // would tokenize as the OR joiner because /^or\b/ only checks the
    // *right* boundary against the slice we hand it.
    const atWordStart = i === 0 || !/\w/.test(input[i - 1])

    if (atWordStart) {
      // Course code (e.g. "CPSC 110", "CPSC_V 110", "MATH 100A").
      // Only recognized when no text run is in progress — i.e. there's
      // a real structural separator (start-of-input, "(", ",", ";", ".",
      // ":", "[", "]", or a keyword that flushed text) immediately
      // before. Mid-prose code-shaped strings like
      // "any course on the STAT_V 200 credit exclusion" must stay inside
      // the surrounding literal so the prereq tree doesn't render the
      // referenced code as an actionable prereq it isn't. The user-
      // visible regression: a few ~10 prereqs that say things like
      // "12 credits at CHIN_V 300" or "must be taken … as EPSE 481"
      // lose CODE detection on the trailing reference; the code still
      // appears in the literal text. Grade-prefix idioms ("a score of
      // N% or higher in CODE") are handled by `stripGradePrefix`
      // upstream so they aren't affected.
      if (textBuf === '') {
        const codeMatch = input.slice(i).match(CODE_RE)
        if (codeMatch) {
          pushToken({
            type: 'CODE',
            value: canonicalizeCode(codeMatch[1], codeMatch[2]),
            start: i,
          })
          i += codeMatch[0].length
          continue
        }

        // Bare-numeric implicit subject continuation. UBC writes lists
        // like "MATH_V 100, 110, 120, 180" or "ECON 101, 102; …" where
        // the items after the first inherit the leading subject. We only
        // expand a bare number when it sits right after a list-context
        // separator (COMMA / OR / AND); after SEMI / DOT / RPAREN /
        // start-of-input it's more often prose ("30 credits required"),
        // and DOT clears the inherited subject entirely. Pattern matches
        // 2-4 digits with optional uppercase suffix — same shape as
        // CODE_RE's number capture.
        if (
          lastCodeSubject &&
          (lastTokenType === 'COMMA' ||
            lastTokenType === 'OR' ||
            lastTokenType === 'AND')
        ) {
          const numMatch = input.slice(i).match(/^(\d{2,4}[A-Z]?)\b/i)
          if (numMatch) {
            pushToken({
              type: 'CODE',
              value: canonicalizeCode(lastCodeSubject, numMatch[1]),
              start: i,
            })
            i += numMatch[0].length
            continue
          }
        }
      }

      // Multi-word keywords. We try these before falling through to TEXT
      // so "one of" doesn't get swallowed as literal text.
      let matchedKw = false
      for (const { re, make } of KW_PATTERNS) {
        const m = input.slice(i).match(re)
        if (m) {
          flushText()
          const tok = make()
          pushToken({ ...tok, start: i })
          i += m[0].length
          matchedKw = true
          break
        }
      }
      if (matchedKw) continue
    }

    // Anything else accumulates into a TEXT token.
    beginTextChar(ch)
    i++
  }

  flushText()
  return tokens
}

// ---------- Parser (recursive descent) ----------

class Parser {
  private pos = 0
  private tokens: Token[]
  // Original (post-strip) input string. Kept so the trailing-drain
  // fallback in `parse()` can slice unparsed prose back out cleanly,
  // preserving its original spacing instead of rebuilding via
  // `reconstructRange` (which space-joins tokens and butchers
  // punctuation spacing).
  private input: string
  constructor(tokens: Token[], input: string) {
    this.tokens = tokens
    this.input = input
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset]
  }

  private match(...types: Array<Token['type']>): boolean {
    const t = this.peek()
    return !!t && types.includes(t.type)
  }

  private consume(): Token | undefined {
    return this.tokens[this.pos++]
  }

  // True when the second LABEL in the stream is preceded by an OR
  // (with no AND or EITHER appearing afterwards) — i.e. the first two
  // labeled siblings are OR-connected. Used by `parse()` to decide
  // whether a bare-labeled top-level prereq dispatches to eitherTail.
  //
  // The "last keyword wins" rule rejects false positives like ELEC 371
  // ("(a) MATH 255 or MATH 256, and either (b) … or (c) …") where an OR
  // sits inside (a)'s content but the actual inter-branch connector
  // between (a) and (b) is "and either …". We track the most recent
  // AND/OR/EITHER keyword between the labels; only a trailing bare OR
  // signals the top-level pattern eitherTail handles.
  private hasInterBranchOr(): boolean {
    let lastKey: 'OR' | 'AND' | 'EITHER' | null = null
    for (let i = 1; i < this.tokens.length; i++) {
      const t = this.tokens[i].type
      if (t === 'LABEL') return lastKey === 'OR'
      if (t === 'OR' || t === 'AND' || t === 'EITHER') lastKey = t
    }
    return false
  }

  parse(): Expr | null {
    if (this.tokens.length === 0) return null
    // Bare top-level labeled disjunction — no leading "Either" keyword.
    // UBC writes a few prereqs as just "(a) X, or (b) Y, or (c) Z"
    // (e.g. DSCI 221: "(a) DSCI 220, or (b) CPSC 121 and one of …").
    // Without dispatching to eitherTail, andExpr only consumes the first
    // labeled branch's content and the rest gets dropped into a drain
    // literal that includes the inter-branch "or, " prose. We dispatch
    // only when an OR + LABEL pattern actually appears in the token
    // stream; bare-labeled prereqs whose branches are conjunction-
    // connected (";", " and ") stay on the andExpr path so AND
    // semantics aren't silently rewritten as OR.
    const expr =
      this.tokens[0]?.type === 'LABEL' && this.hasInterBranchOr()
        ? this.eitherTail()
        : this.andExpr()
    // Drain anything left after the top-level and_expr exits into a
    // single literal so the user still sees the unparsed prose instead
    // of having it silently dropped. Common cause: a clause whose
    // leading keyword the grammar doesn't know (e.g. UBC's "two of: …",
    // "Prerequisite grade requirement: …") — the andExpr loop only
    // resumes on "and" / ";" / ".", so anything that doesn't bind to
    // one of those joiners after the first parsed sub-expr falls off
    // the end. We slice the original input from the first leftover
    // token's offset so spacing is preserved and stripped noise (":",
    // "[", "]") stays gone.
    if (this.pos < this.tokens.length) {
      const start = this.tokens[this.pos].start
      this.pos = this.tokens.length
      const rest = this.input.slice(start).trim()
      if (rest) {
        const restLit: Expr = { kind: 'literal', text: rest }
        if (!expr) return restLit
        // If the parsed expr ends in literal(s) — a common shape when an
        // unknown clause keyword like "two of" parses as a TEXT token
        // first, then bails when the codes after it don't bind — fold
        // them into the drain literal so the user sees one block instead
        // of "two of" + "CHEM 12, PHYS 12, …" split across two.
        if (expr.kind === 'literal') {
          return { kind: 'literal', text: `${expr.text} ${rest}`.trim() }
        }
        if (expr.kind === 'and') {
          const children = [...expr.children, restLit]
          while (
            children.length >= 2 &&
            children[children.length - 1].kind === 'literal' &&
            children[children.length - 2].kind === 'literal'
          ) {
            const b = children.pop() as Extract<Expr, { kind: 'literal' }>
            const a = children[children.length - 1] as Extract<
              Expr,
              { kind: 'literal' }
            >
            // Use no separator when the trailing piece starts with
            // punctuation that already serves as the separator (a drain
            // slice often starts at the COMMA / DOT / SEMI that the
            // parser gave up on). Otherwise insert a single space so
            // adjacent prose doesn't run together.
            const sep = /^\s*[,.;:)]/.test(b.text) ? '' : ' '
            children[children.length - 1] = {
              kind: 'literal',
              text: `${a.text}${sep}${b.text}`.trim(),
            }
          }
          return { kind: 'and', children }
        }
        return { kind: 'and', children: [expr, restLit] }
      }
    }
    return expr
  }

  // and_expr := or_expr (("and" | ";" | ".")+ or_expr)*
  //           | and_expr ("." | ";") "or" and_expr   -> Or-stacked
  // Consecutive joiners are absorbed as a single bridge so a sequence
  // like ". And " (DOT then AND, common in UBC prereq prose like
  // "…361. And 3rd year standing") doesn't lose its right-hand side
  // through atom()'s catch-all consume-and-bail eating the AND.
  //
  // Sentence-boundary OR (the second production above) catches UBC's
  // "<sentence>. Or <sentence>" pattern (e.g. POLI 329:
  // "All of POLI 100, POLI 101, POLI 240. Or third-year standing or
  // higher"). Without it, the OR after the DOT lands at atom()
  // position, gets consumed by the catch-all bail, and the right-hand
  // sentence drains into a literal that's then folded back into the
  // outer AND — turning a disjunction into a spurious extra conjunct.
  // The rule fires only when the joiner sequence actually contained a
  // DOT/SEMI; mid-clause "X and Y or Z" stays on the existing
  // OR-binds-tighter-than-AND path.
  private andExpr(): Expr | null {
    const children: Expr[] = []
    const first = this.orExpr()
    if (first) children.push(first)
    while (this.isAndJoiner()) {
      let sawSentenceBoundary = false
      while (this.isAndJoiner()) {
        const j1 = this.consume()
        if (j1?.type === 'DOT' || j1?.type === 'SEMI') {
          sawSentenceBoundary = true
        }
        // Optional second connector (e.g. ", and" — first consume eats
        // the COMMA, second eats the AND in the same iteration).
        if (this.match('AND', 'SEMI', 'DOT')) {
          const j2 = this.consume()
          if (j2?.type === 'DOT' || j2?.type === 'SEMI') {
            sawSentenceBoundary = true
          }
        }
      }
      if (sawSentenceBoundary && this.match('OR')) {
        this.consume()
        const lhs: Expr | null =
          children.length === 0
            ? null
            : children.length === 1
              ? children[0]
              : { kind: 'and', children }
        const rhs = this.andExpr()
        if (!lhs && !rhs) return null
        if (!lhs) return rhs
        if (!rhs) return lhs
        return { kind: 'or', ui: 'stacked', children: [lhs, rhs] }
      }
      const next = this.orExpr()
      if (next) children.push(next)
    }
    if (children.length === 0) return null
    return children.length === 1 ? children[0] : { kind: 'and', children }
  }

  // Top-level conjunction joiner: AND / SEMI / DOT, or COMMA followed by
  // an AND. The COMMA-AND form catches labeled top-level conjunctions
  // like ELEC 371's "(a) MATH 255 or MATH 256, and either (b) … or (c) …"
  // — andExpr would otherwise stop at the bare COMMA and dump everything
  // after into a drain literal. Plain COMMA without a trailing AND stays
  // disqualified so non-keyword comma lists don't accidentally bind at
  // the top level.
  private isAndJoiner(): boolean {
    if (this.match('AND', 'SEMI', 'DOT')) return true
    if (this.match('COMMA') && this.peek(1)?.type === 'AND') return true
    return false
  }

  // or_expr := atom ("or" atom)*
  // Bare "or" without a preceding "either" produces a flat dropdown disjunction.
  private orExpr(): Expr | null {
    const children: Expr[] = []
    const first = this.atom()
    if (first) children.push(first)
    while (this.match('OR')) {
      this.consume()
      const next = this.atom()
      if (next) children.push(next)
    }
    if (children.length === 0) return null
    return children.length === 1
      ? children[0]
      : { kind: 'or', ui: 'dropdown', children }
  }

  // atom := "one of" code_list
  //       | "all of" code_list
  //       | "either" labeled_branch ("or" labeled_branch)+   -> Or-stacked
  //       | "(" expr ")"
  //       | LABEL atom    (strip leading "(a)"/"(b)" markers)
  //       | CODE
  //       | TEXT
  private atom(): Expr | null {
    // Skip stray labels (e.g. inline "(a)" not preceded by "either" / "or").
    while (this.match('LABEL')) this.consume()

    const t = this.peek()
    if (!t) return null

    if (t.type === 'ONE_OF') {
      this.consume()
      // Labeled "One of (a) … or (b) …" is semantically identical to
      // "Either (a) … or (b) …" — same labels, same picker semantics.
      // Dispatch to the same parser so per-branch absorption (TEXT
      // atoms following a CODE) and the Code+Literal → flattened
      // promotion in eitherBranch apply uniformly. Without this, a
      // branch like MATH 223's "(d) SCIE 001 as a corequisite" parses
      // SCIE 001 as the slot, leaves "as a corequisite" unconsumed,
      // and the trailing literal drains as an orphan AND-conjunct on
      // the outer AST instead of being glued to the branch label.
      // Comma-listed forms ("One of MATH 100, MATH 110, MATH 120")
      // have no LABEL after the keyword and stay on the comma-list
      // path — flat Or-dropdown, no per-branch absorption needed.
      if (this.peek()?.type === 'LABEL') {
        return this.eitherTail()
      }
      const items = this.codeList(false)
      if (items.length === 0) return null
      if (items.length === 1) return items[0]
      return { kind: 'or', ui: 'dropdown', children: items }
    }

    if (t.type === 'ALL_OF') {
      this.consume()
      // ALL_OF doesn't have a stacked UI variant (each conjunct renders
      // as its own block), but the labeled flag still matters for the
      // codeList — UBC's "All of a) X; b) Y; and c) Z" (DSCI 220) needs
      // SEMI / OR + LABEL inter-slot separators recognized so all three
      // labeled branches end up as ALL_OF items rather than just (a)
      // with a drained literal for (b) and (c).
      const isLabeled = this.peek()?.type === 'LABEL'
      const items = this.codeList(isLabeled)
      if (items.length === 0) return null
      return items.length === 1 ? items[0] : { kind: 'and', children: items }
    }

    if (t.type === 'EITHER') {
      this.consume()
      return this.eitherTail()
    }

    if (t.type === 'LPAREN') {
      this.consume()
      const inner = this.andExpr()
      if (this.match('RPAREN')) this.consume()
      return inner
    }

    if (t.type === 'CODE') {
      this.consume()
      return { kind: 'code', code: t.value }
    }

    if (t.type === 'TEXT') {
      this.consume()
      return { kind: 'literal', text: t.value }
    }

    // Joiners / strays we don't expect at this position — consume and bail
    // so the outer loop can resume.
    this.consume()
    return null
  }

  // code_list := code_or_text (sep code_or_text)*
  //
  // Slot separator forms inside "one of …" / "all of …":
  //   - COMMA, optionally followed by "and"/"or" coupling
  //   - SEMI followed by an optional AND/OR run, then a LABEL — UBC
  //     occasionally writes labeled lists with semicolons between slots
  //     ("All of a) X; b) Y; and c) Z" — see DSCI 220).
  //   - Bare OR followed by a LABEL — happens when an inner ONE_OF's
  //     own codeList already absorbed the trailing COMMA and left the
  //     inter-branch OR at this level (see MATH 223's
  //     "One of (a) one of …, or (b) …, or (c) …, or (d) …").
  //
  // Inter-slot OR-with-LABEL specifically does NOT count as a comma-
  // coupling consumed inside the COMMA branch — `, or (e) …` should
  // leave the OR for the next iteration of this loop to consume as a
  // bare-OR+LABEL separator. That preserves APBI 210's existing parse
  // shape (where branch (d)'s ALL_OF doesn't greedily swallow the
  // ", or (e) 7 credits …" sibling).
  // `labeled` is true when the calling ONE_OF / ALL_OF has a LABEL right
  // after its keyword — i.e. this codeList is processing labeled sibling
  // branches like "(a) X, (b) Y". In that mode SEMI followed by a labeled
  // branch (with optional AND/OR coupling) and bare OR followed by a
  // labeled branch are also valid inter-slot separators. For non-labeled
  // inner contexts (e.g. a nested "all of A, B" inside some labeled
  // outer branch — APBI 210's "(d) all of SCIE 001, BIOL 140, or (e) …"),
  // only COMMA separates items so the inner ALL_OF doesn't greedily
  // swallow `, or (e)` that belongs to the outer ONE_OF.
  private codeList(labeled: boolean): Expr[] {
    const items: Expr[] = []
    const first = this.codeListItem()
    if (first) items.push(first)
    while (true) {
      let consumedSep = false
      if (this.match('COMMA')) {
        this.consume()
        consumedSep = true
      } else if (labeled && this.match('SEMI')) {
        let off = 1
        while (
          this.peek(off)?.type === 'AND' ||
          this.peek(off)?.type === 'OR'
        ) {
          off++
        }
        if (this.peek(off)?.type === 'LABEL') {
          this.consume()
          consumedSep = true
        }
      } else if (
        labeled &&
        this.match('OR') &&
        this.peek(1)?.type === 'LABEL'
      ) {
        this.consume()
        consumedSep = true
      }
      if (!consumedSep) break
      if (this.match('AND')) this.consume()
      else if (this.match('OR') && this.peek(1)?.type !== 'LABEL') {
        this.consume()
      }
      const next = this.codeListItem()
      if (next) items.push(next)
    }
    return items
  }

  // One slot inside a "one of" / "all of" comma list. Strips a leading
  // branch label ("(a)", "(b)", …), recurses through atom() so the slot
  // can contain nested "one of …", "all of …", "either …", or a parens-
  // grouped sub-expr (not just a bare CODE/TEXT), and — only when the
  // slot started with a label — absorbs intra-slot alternatives that
  // follow as part of the same labeled branch.
  //
  // The label gate matters: in "all of A, B or X", the "or X" is an
  // OUTER alternative ("the all-of is satisfied OR X"), not part of
  // slot B. Without the gate, slot B would greedily eat "or X" and
  // produce the wrong tree (And[A, Or[B, X]] instead of leaving "or X"
  // for the outer parser). With the gate, only labeled slots like
  // "(a) X or Y" — where the writer has explicitly delimited the slot
  // boundary — opt into the absorption loop.
  //
  // Intra-slot vs inter-slot is decided by lookahead at each separator:
  //   - COMMA / OR followed by a LABEL (with optional AND/OR coupling)
  //     is inter-slot — break and let `codeList` handle it.
  //   - SEMI / DOT / RPAREN / end always end the slot.
  //   - Anything else is intra-slot content and gets pulled in.
  //
  // UBC's labeled slots are typically implicit disjunctions ("(b) MATH
  // 100, 110, 120, 180 or SCIE 001" — pick one of these), so absorbed
  // alternatives wrap as Or-dropdown. Truly intended conjunctions
  // ("(a) X and Y") are rare; AND inside a slot stops absorption and
  // falls back to whatever the outer parser does with the residue.
  //
  // The guard near the top prevents atom()'s catch-all consume-and-bail
  // from silently swallowing a list-level joiner ("," / "and") or
  // parent-grammar terminator ("or" / ";" / "." / ")") it doesn't own.
  private codeListItem(): Expr | null {
    let hadLabel = false
    while (this.match('LABEL')) {
      this.consume()
      hadLabel = true
    }
    if (this.match('OR', 'AND', 'COMMA', 'SEMI', 'DOT', 'RPAREN')) {
      return null
    }
    const first = this.atom()
    if (!first) return null
    if (!hadLabel) return first
    const children: Expr[] = [first]
    while (true) {
      // Hard slot boundaries.
      if (!this.peek()) break
      if (this.match('SEMI', 'DOT', 'RPAREN', 'AND')) break
      if (!this.match('COMMA') && !this.match('OR')) break
      // Look past the separator (and any AND/OR coupling) for a LABEL —
      // if found, this separator belongs to the outer codeList.
      let off = 1
      while (
        this.peek(off)?.type === 'AND' ||
        this.peek(off)?.type === 'OR'
      ) {
        off++
      }
      if (this.peek(off)?.type === 'LABEL') break
      this.consume()
      if (this.match('AND')) this.consume()
      else if (this.match('OR') && this.peek(1)?.type !== 'LABEL') {
        this.consume()
      }
      if (this.match('AND', 'COMMA', 'SEMI', 'DOT', 'RPAREN')) break
      const next = this.atom()
      if (!next) break
      children.push(next)
    }
    return children.length === 1
      ? children[0]
      : { kind: 'or', ui: 'dropdown', children }
  }

  // After "either": collect labeled branches separated by "or" / ";". Each
  // branch is its own and_expr scoped to the branch boundary. Stops at the
  // first joiner that isn't a branch separator (";" / "." can end the
  // either / or block; trailing "and …" continues the outer and_expr).
  //
  // Two modes, decided by whether the first branch starts with a label:
  //   - Labeled ("Either (a) … or (b) …"): only OR-followed-by-LABEL is a
  //     branch separator. A bare OR inside a branch is content — branches
  //     containing one collapse to a single Literal that reconstructs the
  //     branch's original text. Rationale: in UBC's calendar, a writer
  //     who wanted disjunction inside a labeled branch would have used
  //     "one of A, B, C", so a bare OR there is descriptive prose.
  //   - Unlabeled ("Either X or Y or Z"): every OR is a branch separator
  //     and the parent renders as a flat dropdown.
  private eitherTail(): Expr {
    const isLabeled = this.peek()?.type === 'LABEL'
    const branches: Expr[] = []
    let sawLabel = false
    const first = this.eitherBranch(isLabeled)
    if (first.expr) branches.push(first.expr)
    if (first.hasLabel) sawLabel = true
    while (this.match('OR', 'SEMI')) {
      const sep = this.consume()
      if (sep?.type === 'SEMI' && this.match('OR')) this.consume()
      const next = this.eitherBranch(isLabeled)
      if (next.expr) branches.push(next.expr)
      if (next.hasLabel) sawLabel = true
    }
    if (branches.length === 0) {
      return { kind: 'literal', text: 'either' }
    }
    if (branches.length === 1) return branches[0]
    return {
      kind: 'or',
      ui: sawLabel ? 'stacked' : 'dropdown',
      children: branches,
    }
  }

  // A single branch inside "either … or …". Reports whether it consumed a
  // "(a)/(b)/…" label so eitherTail can pick the right UI.
  //   - labeled=false: classic behavior — atoms joined by AND, stops on a
  //     bare OR (which the eitherTail loop then treats as a separator).
  //   - labeled=true: tracks all consumed tokens; if any bare OR
  //     (not OR-followed-by-LABEL) is encountered, the whole branch
  //     collapses to a single Literal reconstructed from those tokens.
  private eitherBranch(
    labeled: boolean,
  ): { expr: Expr | null; hasLabel: boolean } {
    let hasLabel = false
    while (this.match('LABEL')) {
      this.consume()
      hasLabel = true
    }

    if (!labeled) {
      const children: Expr[] = []
      const first = this.atom()
      if (first) children.push(first)
      while (this.match('AND')) {
        this.consume()
        const next = this.atom()
        if (next) children.push(next)
      }
      if (children.length === 0) return { expr: null, hasLabel }
      return {
        expr: children.length === 1 ? children[0] : { kind: 'and', children },
        hasLabel,
      }
    }

    // Labeled mode.
    const branchStart = this.pos
    const children: Expr[] = []
    // Joiner that preceded each pushed child ('or' / 'and' / null). Lets us
    // rebuild the branch's real boolean shape below instead of flattening
    // every atom into one big AND — crucial when a labeled branch writes a
    // disjunction with a bare "or" rather than "one of A, B" (e.g. BIOL 234's
    // "(c) … one of CHEM 203 or CHEM 223 and one of BIOL 112 or BIOL 121").
    const joiners: Array<'or' | 'and' | null> = []
    let sawBareOr = false
    let pending: 'or' | 'and' | null = null
    while (true) {
      const t = this.peek()
      if (!t) break
      if (t.type === 'SEMI' || t.type === 'DOT') break
      if (t.type === 'OR') {
        if (this.peek(1)?.type === 'LABEL') break
        // Bare OR within the branch — a disjunction joiner, not a separator.
        sawBareOr = true
        pending = 'or'
        this.consume()
        continue
      }
      if (t.type === 'AND') {
        // Conjunction joiner between atoms (previously swallowed silently by
        // atom()'s catch-all; now recorded so the structure survives).
        pending = 'and'
        this.consume()
        continue
      }
      const beforePos = this.pos
      const a = this.atom()
      if (!a) {
        // Atom couldn't form one — make sure we make progress so we don't
        // infinite-loop on stray punctuation.
        if (this.pos === beforePos) this.consume()
        continue
      }
      children.push(a)
      joiners.push(pending)
      pending = null
    }

    if (children.length === 0 && !sawBareOr) {
      return { expr: null, hasLabel }
    }

    // Promote to a flattened branch (verbatim prose + walked structural
    // sub-expr) when either:
    //   - we hit a bare OR inside the branch (existing case), or
    //   - the branch mixes a structural atom (Code / group) with a
    //     literal prose atom — e.g. MATH 221 branch (c) "SCIE 001 as a
    //     corequisite". Without this, And[Code, Literal] flowed through
    //     normalize/flattenToProse, which joins And-children with the
    //     English connective "and" — injecting a spurious "and"
    //     ("SCIE 001 and as a corequisite") that doesn't appear in the
    //     calendar text. The reconstructed range gives us the source's
    //     own wording, and the structural sub-expr keeps the upstream
    //     code walkable.
    const hasLiteral = children.some((c) => c.kind === 'literal')
    const hasStructural = children.some((c) => c.kind !== 'literal')
    if (sawBareOr || (hasLiteral && hasStructural)) {
      const text = this.reconstructRange(branchStart, this.pos).trim()
      // Honour the branch's real and/or structure (OR binds tighter than AND)
      // so a "one of X or Y and one of A or B" branch evaluates as
      // (X∨Y)∧(A∨B), not a conjunction of all four.
      const subExpr = groupBranchChildren(children, joiners)
      return { expr: { kind: 'flattened', text, subExpr }, hasLabel }
    }

    return {
      expr: children.length === 1 ? children[0] : { kind: 'and', children },
      hasLabel,
    }
  }

  // Reconstruct the original-ish text of tokens[from..to). Used when a
  // labeled either-branch contains a bare OR — we want to display the
  // branch as the user wrote it, not as a half-parsed structure.
  private reconstructRange(from: number, to: number): string {
    const parts: string[] = []
    for (let i = from; i < to; i++) {
      const text = tokenText(this.tokens[i])
      if (text) parts.push(text)
    }
    return parts.join(' ')
  }
}

function tokenText(t: Token): string {
  switch (t.type) {
    case 'CODE':
      return t.value
    case 'TEXT':
      return t.value
    case 'ONE_OF':
      return 'one of'
    case 'ALL_OF':
      return 'all of'
    case 'EITHER':
      return 'either'
    case 'AND':
      return 'and'
    case 'OR':
      return 'or'
    case 'COMMA':
      return ','
    case 'SEMI':
      return ';'
    case 'DOT':
      return '.'
    case 'LPAREN':
      return '('
    case 'RPAREN':
      return ')'
    case 'LABEL':
      return ''
  }
}

// Rebuild a labeled either-branch's boolean structure from its atoms and the
// joiners between them. Consecutive atoms linked by "or" form a disjunction;
// "and" (or a group boundary) starts a new conjunct — i.e. OR binds tighter
// than AND, matching the main grammar. So a branch like
//   "one of CHEM 203 or CHEM 223 and one of BIOL 112 or BIOL 121"
// becomes (CHEM 203 ∨ CHEM 223) ∧ (BIOL 112 ∨ BIOL 121), not a flat AND of
// all four. Literal prose atoms carry no logical weight here (their wording is
// preserved in the flattened node's display text), so they're skipped.
// Returns null when no structural atom remains.
function groupBranchChildren(
  children: Expr[],
  joiners: Array<'or' | 'and' | null>,
): Expr | null {
  const groups: Expr[][] = []
  for (let i = 0; i < children.length; i++) {
    const c = children[i]
    if (c.kind === 'literal') continue
    if (joiners[i] === 'or' && groups.length > 0) {
      groups[groups.length - 1].push(c)
    } else {
      groups.push([c])
    }
  }
  if (groups.length === 0) return null
  const conjuncts: Expr[] = groups.map((g) =>
    g.length === 1 ? g[0] : { kind: 'or', ui: 'dropdown', children: g },
  )
  return conjuncts.length === 1
    ? conjuncts[0]
    : { kind: 'and', children: conjuncts }
}

// ---------- Normalization ----------

// True if `expr` is a "structural" subtree — every leaf is a Code with no
// prose mixed in. Pure-code branches stay actionable in the rendered
// graph (the user can select / expand them); anything else collapses to
// a single literal info block.
function isPureCode(expr: Expr): boolean {
  switch (expr.kind) {
    case 'code':
      return true
    case 'literal':
    case 'flattened':
      return false
    case 'soft':
      return isPureCode(expr.child)
    case 'and':
    case 'or':
      return expr.children.every(isPureCode)
  }
}

// Flatten an expression back to a single prose string for the
// collapsed-literal info block. Joins And/Or with their natural English
// connectives so the block reads close to the source text.
function flattenToProse(expr: Expr): string {
  switch (expr.kind) {
    case 'code':
      return expr.code
    case 'literal':
    case 'flattened':
      return expr.text
    case 'soft':
      return flattenToProse(expr.child)
    case 'and':
      return expr.children
        .map(flattenToProse)
        .filter((s) => s)
        .join(' and ')
    case 'or':
      return expr.children
        .map(flattenToProse)
        .filter((s) => s)
        .join(' or ')
  }
}

// Flatten same-kind nesting (And inside And, Or-dropdown inside Or-dropdown
// at the same UI level), collapse single-child groups, then apply the
// structural per-branch rule:
//
//   - Disjunction (Or-dropdown / Or-stacked): each branch must be either
//     a pure-code subtree (stays selectable / expandable) or a single
//     literal (inert prose). Mixed-tree branches like And[Code, Lit]
//     collapse to one literal showing the branch's verbatim prose — the
//     partial structure isn't actionable, and shredding it across
//     dropdown rows confuses the user. After per-branch collapse, if
//     every branch is now a literal, the whole disjunction collapses to
//     one literal. Flattened either-branches are passed through (their
//     hybrid prose-label + subExpr-walk is intentional structure).
//
//   - Conjunction (And): keep all children as-is — conjunction means
//     "satisfy all", so every child belongs in the graph. The exception
//     is And-of-all-literals, which collapses to a single literal so
//     things like "Third- or fourth-year class standing and permission
//     of the Department Head" land in one info block instead of two.
//
// This replaces the previous per-idiom heuristics ("standing", "credits
// from", …) with a structural rule that doesn't care what the prose
// says — only whether the parser turned it into actionable structure.
function normalize(expr: Expr): Expr {
  if (expr.kind === 'code' || expr.kind === 'literal') return expr
  if (expr.kind === 'flattened') {
    return {
      kind: 'flattened',
      text: expr.text,
      subExpr: expr.subExpr ? normalize(expr.subExpr) : null,
    }
  }
  if (expr.kind === 'soft') {
    const inner = normalize(expr.child)
    // Drop the wrapper if the soft clause normalized away to nothing.
    if (inner.kind === 'literal' && !inner.text.trim()) return inner
    return { kind: 'soft', child: inner }
  }

  const children = expr.children.map(normalize).flatMap((c) => {
    if (
      c.kind === expr.kind &&
      (c.kind !== 'or' || (expr.kind === 'or' && c.ui === expr.ui))
    ) {
      return c.children
    }
    return [c]
  })

  if (children.length === 0) return { kind: 'literal', text: '' }
  if (children.length === 1) return children[0]

  if (expr.kind === 'or') {
    const collapsed: Expr[] = children.map((c) => {
      if (c.kind === 'flattened') return c
      return isPureCode(c) ? c : { kind: 'literal', text: flattenToProse(c) }
    })
    if (collapsed.every((c) => c.kind === 'literal')) {
      const text = collapsed
        .map((c) => (c as Extract<Expr, { kind: 'literal' }>).text)
        .filter((s) => s)
        .join(' or ')
      return { kind: 'literal', text }
    }
    return { kind: 'or', ui: expr.ui, children: collapsed }
  }

  if (children.every((c) => c.kind === 'literal')) {
    const text = children
      .map((c) => (c as Extract<Expr, { kind: 'literal' }>).text)
      .filter((s) => s)
      .join(' and ')
    return { kind: 'literal', text }
  }
  return { kind: 'and', children }
}

// ---------- Public API ----------

// Pre-tokenizer rewrite: collapse "[a/A] grade/score of NN% or higher in
// <items>" into "one of <items>", with any " or " joiners inside <items>
// rewritten to commas so the codeList parser surfaces them as
// alternatives. The "or" inside the grade idiom is part of the phrase,
// not a disjunction joiner — and the items after "in" are the actual
// prerequisite options, not prose. Without this, the bare-OR-inside-a-
// labeled-either-branch rule would flatten the whole thing to a literal
// blob and the items wouldn't surface as selectable options.
//
// Match runs up to the first ".", ";", or end of string so we don't eat
// past the items list into trailing constraints ("…; and 3rd-year
// standing"). The capture is non-greedy with a lookahead that also stops
// at the next labeled branch boundary. Two boundary shapes are
// recognized:
//   - comma-prefixed: ", b)" / ", or b)" / ", and (b)" / ", (b)" — used
//     by MATH 121 ("…in MATH 120, b) a score of 80% or higher…").
//   - bare connector: " or (b)" / " and (b)" — used by MATH 226
//     ("…in MATH 121 or (b) a score of 80%…"). Without recognizing this
//     boundary, the non-greedy items capture falls through to `$` and
//     swallows both labeled branches in one match, collapsing the
//     Either-stacked structure into a single flat dropdown.
// The 'g' / 'i' flags let multiple grade phrases per prereq each get
// rewritten and case-fold the whole pattern so "A Grade of 80%…" matches
// the same as "a grade of 80%…".
const GRADE_PREFIX_RE =
  /\ba\s+(?:grade|score)\s+of\s+\d+\s*%\s+or\s+(?:higher|better)\s+in\s+([^.;]+?)(?=\s*(?:,\s*(?:and\s+|or\s+)?|(?:and|or)\s+)\(?\s*[a-z]\s*\)|;|\.|$)/gi

function stripGradePrefix(input: string): string {
  return input.replace(GRADE_PREFIX_RE, (_match, items: string) => {
    // If the source already wrote "in one of …" (e.g. MATH 226 branch
    // (b): "a score of 80% or higher in one of MATH 101, MATH 103, …"),
    // emit the items verbatim. Otherwise we'd produce "one of one of …",
    // which the parser then mis-tokenizes as a single ONE_OF over a
    // garbled list.
    const trimmed = items.trim()
    if (/^one\s+of\b/i.test(trimmed)) return trimmed
    const itemsAsList = trimmed.replace(/\s+or\s+/gi, ', ')
    return `one of ${itemsAsList}`
  })
}

// Trailing UBC boilerplate disclaimers that aren't actually prerequisites.
// These show up at the tail of ~1200 prereq strings in the calendar — if
// we leave them in, they survive parsing as a literal block (or bleed
// into the drain fallback) and pollute the prereq tree with policy text.
//
// Anchor to end-of-string with an optional sentence separator and trailing
// period so we strip the lead-in punctuation too ("…BIOL 12). This course
// is not eligible…" → "…BIOL 12)").
const TRAILING_NOISE_RES: RegExp[] = [
  /\s*[.,;]?\s*This course is not eligible for Credit\/D\/Fail grading\.?\s*$/i,
]

function stripTrailingNoise(input: string): string {
  let out = input
  // Loop because some prereqs may end in multiple disclaimers stacked
  // back-to-back; one pass per regex isn't enough if a future addition
  // matches what an earlier one exposed.
  let changed = true
  while (changed) {
    changed = false
    for (const re of TRAILING_NOISE_RES) {
      const next = out.replace(re, '')
      if (next !== out) {
        out = next
        changed = true
      }
    }
  }
  return out
}

// Trailing recommendation suffix at the very end of a prereq string. UBC
// uses many near-identical wordings ("X is recommended", "X are
// recommended", "X strongly recommended", "X is also recommended", "X is
// recommended in these courses", "X is recommended as either a
// prerequisite or corequisite", "X is recommended for others", …). The
// `.*$` after `recommended\b` greedily eats any qualifier prose up to
// end of string. Anchored to `$` so mid-sentence "recommended" doesn't
// false-trigger; `stripTrailingNoise` runs first and removes the
// Credit/D/Fail disclaimer that often follows, so by the time this runs
// the recommendation phrase really is at the tail.
const RECOMMEND_TAIL_RE =
  /\s+(?:(?:is|are)\s+)?(?:(?:strongly|highly|also)\s+)?recommended\b.*$/i

// Split a prereq string into a hard clause (mandatory) and a soft clause
// (the recommended-but-not-required tail). When the recommendation
// suffix matches, we strip it and split the remaining text on the LAST
// "." — anything after the period is the soft clause, anything before
// is the mandatory prereq.
//
// Examples (disclaimer already stripped upstream):
//   "BIOL 351. BIOL 406 or 407 are recommended"
//     → hard "BIOL 351", soft "BIOL 406 or 407"
//   "AMNE 200 is recommended"
//     → hard "", soft "AMNE 200"   (whole thing is a recommendation)
//   "Third-year standing or higher. APBI 314 and APBI 315 are recommended"
//     → hard "Third-year standing or higher",
//       soft "APBI 314 and APBI 315"
//
// Cases where the recommendation suffix is followed by extra prose
// ("recommended for students with …", "recommended as either a prereq
// or coreq") don't match the regex and fall through unchanged.
function splitRecommended(input: string): {
  hard: string
  soft: string | null
} {
  const match = input.match(RECOMMEND_TAIL_RE)
  if (!match || match.index === undefined) return { hard: input, soft: null }
  // Don't extract when "recommended" sits inside an unbalanced paren —
  // mid-clause forms like "KIN 320 (KIN 351 strongly recommended)" or
  // "MICB_V 212 recommended)" would lose the closing paren if we let
  // the lenient `recommended\b.*$` swallow past it. Fall through and
  // let the regular parser handle the prereq with the parenthetical
  // intact.
  let depth = 0
  for (let i = 0; i < match.index; i++) {
    if (input[i] === '(') depth++
    else if (input[i] === ')') depth--
  }
  if (depth > 0) return { hard: input, soft: null }
  const stripped = input.slice(0, match.index).trim()
  const lastDot = stripped.lastIndexOf('.')
  if (lastDot === -1) return { hard: '', soft: stripped }
  return {
    hard: stripped.slice(0, lastDot).trim(),
    soft: stripped.slice(lastDot + 1).trim(),
  }
}

// Parse a single clause (hard or soft) into a normalized AST. Returns
// null on empty / unparseable input.
function parseClause(raw: string): Expr | null {
  const trimmed = stripGradePrefix(raw).trim()
  if (!trimmed) return null
  const tokens = tokenize(trimmed)
  if (tokens.length === 0) return null
  const ast = new Parser(tokens, trimmed).parse()
  if (!ast) return null
  return normalize(ast)
}

/**
 * Parse a raw prereq string into an AST. Returns null for empty / whitespace
 * input. Anything the grammar can't make sense of becomes a `Literal` and
 * is preserved in the tree (the renderer decides what to do with it).
 *
 * If the input ends in a "<X> [is/are] [strongly/highly/also] recommended"
 * tail, the soft clause is parsed separately and wrapped in `kind: 'soft'`
 * so the renderer can style it with dotted "optional" edges. The hard
 * clause (everything before the last "." preceding the recommendation)
 * parses as a normal prereq tree.
 */
export function parsePrereq(raw: string | null | undefined): Expr | null {
  if (!raw) return null
  // Bare "none" is the chunker's placeholder for an absent prereq/coreq
  // string (`chunk_and_embed.py` emits "Prerequisites: None" so the LLM
  // sees the explicit signal). For the prereq tree it means "nothing to
  // render" — without this short-circuit it would parse to a literal
  // info block that just says "None".
  if (/^\s*none\s*\.?\s*$/i.test(raw)) return null
  const noNoise = stripTrailingNoise(raw.trim())
  const { hard, soft } = splitRecommended(noNoise)
  const hardExpr = hard ? parseClause(hard) : null
  const softExpr = soft ? parseClause(soft) : null
  if (!hardExpr && !softExpr) return null
  if (!hardExpr && softExpr) return { kind: 'soft', child: softExpr }
  if (hardExpr && !softExpr) return hardExpr
  // Both present — combine as conjunction (the soft wrapper just changes
  // edge styling, it doesn't alter "you also need …" semantics relative
  // to the hard clause). Run the combined tree through normalize once
  // more so same-kind ANDs flatten if hardExpr was itself an `and`.
  return normalize({
    kind: 'and',
    children: [hardExpr!, { kind: 'soft', child: softExpr! }],
  })
}

/**
 * Flatten an expression to a comma-separated string of the codes it
 * mentions, in left-to-right order. Used by the renderer to label
 * disjunction options like "PHYS 101, 106, 107 + MATH 101, 103". Literals
 * in the tree show up as their text. Falls back to "(empty)" when the
 * expression has no displayable content.
 */
export function displayExpr(expr: Expr): string {
  switch (expr.kind) {
    case 'code':
      return expr.code
    case 'literal':
      return expr.text || '(empty)'
    case 'flattened':
      return expr.text || '(empty)'
    case 'soft':
      return displayExpr(expr.child)
    case 'and':
      return expr.children.map(displayExpr).join(' + ')
    case 'or':
      return expr.children.map(displayExpr).join(' / ')
  }
}

/**
 * Evaluate a prereq AST against a set of already-completed course codes.
 * Used by the Degree Planner to flag blocks whose prereqs aren't met by
 * earlier terms (or, for coreqs, by earlier-or-same terms).
 *
 * Unevaluable branches (raw `literal` prose like "third-year standing" or
 * a `flattened` clause with no extractable code structure) are *skipped*
 * inside AND/OR rather than treated as satisfied. That asymmetric
 * behaviour matters: when a course's prereq is something like
 *   "Either (a) one of MATH 100/102/… or (b) advanced credit for MATH 100"
 * UBC's branch (b) parses as a literal, and the old "literal = true"
 * rule made the entire OR look satisfied even when the student has
 * nothing planned. Skipping literals lets the evaluator answer based on
 * the branches it can actually verify; when every branch is unevaluable
 * the result defaults to satisfied (we can't disprove it, so don't
 * paint a red border over prose conditions we can't reason about).
 *
 * `soft` always evaluates to satisfied — it wraps a recommendation, not
 * a requirement.
 */
export function isSatisfied(
  expr: Expr | null,
  completed: Set<string>,
): boolean {
  if (!expr) return true
  switch (expr.kind) {
    case 'code':
      return completed.has(expr.code)
    case 'and': {
      const evaluable = expr.children.filter((c) => !isUnevaluable(c))
      if (evaluable.length === 0) return true
      return evaluable.every((c) => isSatisfied(c, completed))
    }
    case 'or': {
      const evaluable = expr.children.filter((c) => !isUnevaluable(c))
      if (evaluable.length === 0) return true
      return evaluable.some((c) => isSatisfied(c, completed))
    }
    case 'soft':
      return true
    case 'literal':
      return true
    case 'flattened':
      return expr.subExpr ? isSatisfied(expr.subExpr, completed) : true
  }
}

// A node is "unevaluable" when nothing inside it maps to a course code
// the planner can check. Pure literals (e.g. "third-year standing") and
// flattened branches whose parser couldn't extract any structured code
// both qualify. AND/OR with mixed evaluable + unevaluable children
// ignore the unevaluable ones during satisfaction checks.
function isUnevaluable(expr: Expr): boolean {
  if (expr.kind === 'literal') return true
  if (expr.kind === 'flattened' && expr.subExpr === null) return true
  return false
}

/**
 * Collect the unmet pieces of a prereq tree as displayable strings — one
 * per top-level unsatisfied AND-child, with OR-groups flattened as
 * "X / Y / Z" via displayExpr. Returns [] when fully satisfied. Feeds the
 * tooltip on red-bordered planner blocks.
 */
export function missingPrereqs(
  expr: Expr | null,
  completed: Set<string>,
): string[] {
  if (!expr) return []
  if (isSatisfied(expr, completed)) return []
  switch (expr.kind) {
    case 'code':
      return [expr.code]
    case 'and':
      return expr.children
        .filter((c) => !isUnevaluable(c))
        .flatMap((c) => missingPrereqs(c, completed))
    case 'or':
      // OR fails only when all branches fail — surface the whole group
      // collapsed to "A / B / C" so the user sees the choices, not just
      // the first arm.
      return [displayExpr(expr)]
    case 'soft':
    case 'literal':
      return []
    case 'flattened':
      return expr.subExpr ? missingPrereqs(expr.subExpr, completed) : []
  }
}
