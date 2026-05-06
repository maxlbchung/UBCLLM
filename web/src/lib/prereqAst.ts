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

// Course-code canonicalization — same shape `extractCourseCodes` in
// retrieve.ts produces ("CPSC 110", uppercased, no `_V` suffix). Keys built
// from this string are looked up in the same `getCourseIndex()` Map.
const CODE_RE = /^([A-Z]{3,5})(?:_V)?\s*(\d{2,4}[A-Z]?)\b/i

function canonicalizeCode(subject: string, number: string): string {
  return `${subject.toUpperCase()} ${number.toUpperCase()}`
}

// ---------- Tokenizer ----------

type Token =
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

// Words/symbols the lexer treats as token boundaries. Anything else
// accumulates into a TEXT token.
const KW_PATTERNS: Array<{ re: RegExp; make: () => Token }> = [
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

  const flushText = () => {
    const trimmed = textBuf.trim()
    if (trimmed) tokens.push({ type: 'TEXT', value: trimmed })
    textBuf = ''
  }

  while (i < input.length) {
    const ch = input[i]
    if (/\s/.test(ch)) {
      textBuf += ch
      i++
      continue
    }

    // Branch label: "(a)", "(b)", … — only single ASCII letter inside parens.
    // Anything else inside parens is a real LPAREN.
    const labelMatch = input.slice(i).match(/^\(\s*([a-z])\s*\)/i)
    if (labelMatch) {
      flushText()
      tokens.push({ type: 'LABEL' })
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
        tokens.push({ type: 'LABEL' })
        i += looseMatch[0].length
        continue
      }
    }

    if (ch === '(') {
      flushText()
      tokens.push({ type: 'LPAREN' })
      i++
      continue
    }
    if (ch === ')') {
      flushText()
      tokens.push({ type: 'RPAREN' })
      i++
      continue
    }
    if (ch === ',') {
      flushText()
      tokens.push({ type: 'COMMA' })
      i++
      continue
    }
    if (ch === ';') {
      flushText()
      tokens.push({ type: 'SEMI' })
      i++
      continue
    }
    if (ch === '.') {
      flushText()
      tokens.push({ type: 'DOT' })
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
      const codeMatch = input.slice(i).match(CODE_RE)
      if (codeMatch) {
        flushText()
        tokens.push({
          type: 'CODE',
          value: canonicalizeCode(codeMatch[1], codeMatch[2]),
        })
        i += codeMatch[0].length
        continue
      }

      // Multi-word keywords. We try these before falling through to TEXT
      // so "one of" doesn't get swallowed as literal text.
      let matchedKw = false
      for (const { re, make } of KW_PATTERNS) {
        const m = input.slice(i).match(re)
        if (m) {
          flushText()
          tokens.push(make())
          i += m[0].length
          matchedKw = true
          break
        }
      }
      if (matchedKw) continue
    }

    // Anything else accumulates into a TEXT token.
    textBuf += ch
    i++
  }

  flushText()
  return tokens
}

// ---------- Parser (recursive descent) ----------

class Parser {
  private pos = 0
  private tokens: Token[]
  constructor(tokens: Token[]) {
    this.tokens = tokens
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

  parse(): Expr | null {
    if (this.tokens.length === 0) return null
    const expr = this.andExpr()
    return expr
  }

  // and_expr := or_expr (("and" | ";" | ".")+ or_expr)*
  // Consecutive joiners are absorbed as a single bridge so a sequence
  // like ". And " (DOT then AND, common in UBC prereq prose like
  // "…361. And 3rd year standing") doesn't lose its right-hand side
  // through atom()'s catch-all consume-and-bail eating the AND.
  private andExpr(): Expr | null {
    const children: Expr[] = []
    const first = this.orExpr()
    if (first) children.push(first)
    while (this.match('AND', 'SEMI', 'DOT')) {
      while (this.match('AND', 'SEMI', 'DOT')) this.consume()
      const next = this.orExpr()
      if (next) children.push(next)
    }
    if (children.length === 0) return null
    return children.length === 1 ? children[0] : { kind: 'and', children }
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
      const items = this.codeList()
      if (items.length === 0) return null
      return items.length === 1 ? items[0] : { kind: 'or', ui: 'dropdown', children: items }
    }

    if (t.type === 'ALL_OF') {
      this.consume()
      const items = this.codeList()
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

  // code_list := code_or_text ("," ("and"|"or")? code_or_text)*
  // Comma-separated slots inside "one of …" / "all of …". A trailing
  // "and X" / "or X" inside the list is treated as just another item
  // ("one of A, B, and C" / "one of A, B, or C" → 3 items). The OR is
  // only consumed when the next token is NOT a LABEL — `, or (e) …`
  // signals that "(e)" is an outer labeled branch, so the OR belongs to
  // the parent disjunction, not this comma list. Without this guard
  // APBI 210's branch (d) ALL_OF would greedily swallow ", or (e) 7
  // credits of first-year" into its own item list.
  private codeList(): Expr[] {
    const items: Expr[] = []
    const first = this.codeListItem()
    if (first) items.push(first)
    while (this.match('COMMA')) {
      this.consume()
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
  // slot started with a label — absorbs any OR-joined alternatives that
  // follow as part of the same labeled branch.
  //
  // The label gate matters: in "all of A, B or X", the "or X" is an
  // OUTER alternative ("the all-of is satisfied OR X"), not part of
  // slot B. Without the gate, slot B would greedily eat "or X" and
  // produce the wrong tree (And[A, Or[B, X]] instead of leaving "or X"
  // for the outer parser). With the gate, only labeled slots like
  // "(a) X or Y" — where the writer has explicitly delimited the slot
  // boundary — opt into the OR loop.
  //
  // The guard at the top prevents atom()'s catch-all consume-and-bail
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
    if (!hadLabel || !this.match('OR')) return first
    const children: Expr[] = [first]
    while (this.match('OR')) {
      this.consume()
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
    let sawBareOr = false
    while (true) {
      const t = this.peek()
      if (!t) break
      if (t.type === 'SEMI' || t.type === 'DOT') break
      if (t.type === 'OR') {
        const next = this.peek(1)
        if (next?.type === 'LABEL') break
        // Bare OR within the branch — content, not a separator.
        sawBareOr = true
        this.consume()
        continue
      }
      // Stray AND (and any other unexpected joiner) is swallowed by atom()'s
      // catch-all consume-and-bail; we don't need an explicit handler here.
      const beforePos = this.pos
      const a = this.atom()
      if (!a) {
        // Atom couldn't form one — make sure we make progress so we don't
        // infinite-loop on stray punctuation.
        if (this.pos === beforePos) this.consume()
        continue
      }
      children.push(a)
    }

    if (children.length === 0 && !sawBareOr) {
      return { expr: null, hasLabel }
    }

    if (sawBareOr) {
      const text = this.reconstructRange(branchStart, this.pos).trim()
      // Preserve any structure the branch's atoms produced (single Code,
      // Or-dropdown, etc.) so the renderer can still draw a real upstream
      // block — e.g. "a score of 80% in one of MATH 101, MATH 103" should
      // render the prose AND a trailing dropdown of the two courses.
      // Drop pure-text Literal atoms; they're already in `text`.
      const structural = children.filter((c) => c.kind !== 'literal')
      const subExpr: Expr | null =
        structural.length === 0
          ? null
          : structural.length === 1
            ? structural[0]
            : { kind: 'and', children: structural }
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
// at the next labeled branch boundary — `, b)` / `, or c)` / `, (b)` —
// so a multi-branch prereq like MATH 121's "Either a) a score of 68%
// or higher in MATH 120, b) a score of 80% or higher in MATH 100, …"
// gets two separate rewrites instead of one over-greedy slurp from the
// first phrase to end-of-string. The 'g' / 'i' flags let multiple grade
// phrases per prereq each get rewritten and case-fold the whole pattern
// so "A Grade of 80%…" matches the same as "a grade of 80%…".
const GRADE_PREFIX_RE =
  /\ba\s+(?:grade|score)\s+of\s+\d+\s*%\s+or\s+higher\s+in\s+([^.;]+?)(?=\s*,\s*(?:and\s+|or\s+)?\(?\s*[a-z]\s*\)|;|\.|$)/gi

function stripGradePrefix(input: string): string {
  return input.replace(GRADE_PREFIX_RE, (_match, items: string) => {
    const itemsAsList = items.replace(/\s+or\s+/gi, ', ')
    return `one of ${itemsAsList}`
  })
}

/**
 * Parse a raw prereq string into an AST. Returns null for empty / whitespace
 * input. Anything the grammar can't make sense of becomes a `Literal` and
 * is preserved in the tree (the renderer decides what to do with it).
 */
export function parsePrereq(raw: string | null | undefined): Expr | null {
  if (!raw) return null
  const trimmed = stripGradePrefix(raw.trim())
  if (!trimmed) return null
  const tokens = tokenize(trimmed)
  if (tokens.length === 0) return null
  const ast = new Parser(tokens).parse()
  if (!ast) return null
  return normalize(ast)
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
    case 'and':
      return expr.children.map(displayExpr).join(' + ')
    case 'or':
      return expr.children.map(displayExpr).join(' / ')
  }
}
