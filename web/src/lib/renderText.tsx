import type { ReactNode } from 'react'

// Match an http(s) URL up to (but not including) whitespace, brackets,
// parens, or angle brackets. Mirrors the URL absorber in the prereq
// tokenizer (`prereqAst.ts`) so what we extract here is the same
// substring that survived as one chunk inside the literal.
const URL_RE = /(https?:\/\/[^\s<>\]\[)]+)/gi

/**
 * Render a string with embedded URLs as clickable links and the rest as
 * plain text. Used inside literal blocks of the prereq tree (note-variant
 * CourseNode, DisjunctionNode literal-detail row) so a UBC calendar
 * reference URL inlined into a prereq string ("…credit exclusion:
 * https://vancouver.calendar.ubc.ca/…") stays clickable.
 *
 * String.split with a single capturing group puts captures at odd
 * indices and the surrounding text at even indices.
 */
export function renderTextWithLinks(text: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        // Stop the click from bubbling to the ReactFlow pane (or the
        // surrounding dropdown trigger), which would otherwise treat
        // it as a node drag / dropdown toggle.
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          color: '#60a5fa',
          textDecoration: 'underline',
          wordBreak: 'break-all',
        }}
      >
        {part}
      </a>
    ) : (
      part
    ),
  )
}
