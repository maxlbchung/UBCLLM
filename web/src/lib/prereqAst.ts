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

  // and_expr := or_expr (("and" | ";" | ".") or_expr)*
  private andExpr(): Expr | null {
    const children: Expr[] = []
    const first = this.orExpr()
    if (first) children.push(first)
    while (this.match('AND', 'SEMI', 'DOT')) {
      this.consume()
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

  // code_list := code_or_text ("," code_or_text)* ("," "and" code_or_text)?
  // Comma-separated atoms inside "one of …" / "all of …". A trailing
  // "and X" inside the list is treated as just another item ("one of A, B,
  // and C" → 3 items).
  private codeList(): Expr[] {
    const items: Expr[] = []
    const first = this.codeListItem()
    if (first) items.push(first)
    while (this.match('COMMA')) {
      this.consume()
      // Allow "A, B, and C" — eat the "and" after a comma.
      if (this.match('AND')) this.consume()
      const next = this.codeListItem()
      if (next) items.push(next)
    }
    return items
  }

  private codeListItem(): Expr | null {
    const t = this.peek()
    if (!t) return null
    if (t.type === 'CODE') {
      this.consume()
      return { kind: 'code', code: t.value }
    }
    if (t.type === 'TEXT') {
      this.consume()
      return { kind: 'literal', text: t.value }
    }
    return null
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
      if (t.type === 'AND') {
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

// Flatten same-kind nesting (And inside And, Or-dropdown inside Or-dropdown
// at the same UI level) and collapse single-child groups.
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
  if (expr.kind === 'and') return { kind: 'and', children }
  return { kind: 'or', ui: expr.ui, children }
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
// standing"). The 'g' / 'i' flags let multiple grade phrases in one
// prereq string each get rewritten.
const GRADE_PREFIX_RE =
  /\b[Aa]\s+(?:grade|score)\s+of\s+\d+\s*%\s+or\s+higher\s+in\s+([^.;]+)/g

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
