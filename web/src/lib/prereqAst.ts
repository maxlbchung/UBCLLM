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

    // Multi-word keywords. We try these before falling through to TEXT so
    // "one of" doesn't get swallowed as literal text.
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
  private eitherTail(): Expr {
    const branches: Expr[] = []
    // First branch — strip optional leading label, then read everything up
    // to the next "or" / ";" (which separates branches).
    const first = this.eitherBranch()
    if (first) branches.push(first)
    while (this.match('OR', 'SEMI')) {
      // ";" before "or" is fine — eat both.
      const sep = this.consume()
      if (sep?.type === 'SEMI' && this.match('OR')) this.consume()
      const next = this.eitherBranch()
      if (next) branches.push(next)
    }
    if (branches.length === 0) {
      // Malformed "either" with no content — return a placeholder literal.
      return { kind: 'literal', text: 'either' }
    }
    if (branches.length === 1) return branches[0]
    return { kind: 'or', ui: 'stacked', children: branches }
  }

  // A single labeled branch inside "either … or …". Reads until a branch
  // separator (";", "or") or hard terminator (".").
  private eitherBranch(): Expr | null {
    while (this.match('LABEL')) this.consume()
    // Branch body: collect atoms joined by "and" until we hit a separator.
    const children: Expr[] = []
    const first = this.atom()
    if (first) children.push(first)
    while (this.match('AND')) {
      this.consume()
      const next = this.atom()
      if (next) children.push(next)
    }
    if (children.length === 0) return null
    return children.length === 1 ? children[0] : { kind: 'and', children }
  }
}

// ---------- Normalization ----------

// Flatten same-kind nesting (And inside And, Or-dropdown inside Or-dropdown
// at the same UI level) and collapse single-child groups.
function normalize(expr: Expr): Expr {
  if (expr.kind === 'code' || expr.kind === 'literal') return expr

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

/**
 * Parse a raw prereq string into an AST. Returns null for empty / whitespace
 * input. Anything the grammar can't make sense of becomes a `Literal` and
 * is preserved in the tree (the renderer decides what to do with it).
 */
export function parsePrereq(raw: string | null | undefined): Expr | null {
  if (!raw) return null
  const trimmed = raw.trim()
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
    case 'and':
      return expr.children.map(displayExpr).join(' + ')
    case 'or':
      return expr.children.map(displayExpr).join(' / ')
  }
}
