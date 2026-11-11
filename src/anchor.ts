/**
 * Pure anchor-tracking logic (no `vscode` import, so it is unit-testable with plain node).
 *
 * A comment is anchored to a span of UTF-16 offsets [start, end) in the document, the same unit
 * VS Code uses for `TextDocument.offsetAt` and `TextDocumentContentChangeEvent.rangeOffset`.
 * Instead of re-finding the span later from prefix/suffix context, we move it through every edit
 * as it happens (the same idea Overleaf uses with operational transformation).
 */

export interface Span {
  start: number;
  end: number;
}

/** One edit, expressed in offsets of the document *before* the edit. */
export interface Change {
  offset: number;
  deleteLength: number;
  text: string;
}

/**
 * Move `span` through a single edit.
 *
 * Boundary behaviour (chosen to feel like Overleaf):
 *  - typing right before or right after a commented word does not extend the comment;
 *  - typing inside it grows it;
 *  - deleting the whole commented text collapses the comment to a point. It is never dropped;
 *  - typing at a collapsed point regrows it, so undoing a deletion brings the highlight back;
 *  - if a large replacement (an external reload, a formatter, or pasting over a block) swallows
 *    the span but the new text still contains the quoted text, the comment re-attaches there.
 */
export function transformSpan(span: Span, ch: Change, quote = ''): Span {
  const { start, end } = span;
  const off = ch.offset;
  const delEnd = ch.offset + ch.deleteLength;
  const ins = ch.text.length;
  const delta = ins - ch.deleteLength;

  // 1. Pure insertion.
  if (ch.deleteLength === 0) {
    if (start === end && off === start) return { start: off, end: off + ins };
    if (off <= start) return { start: start + ins, end: end + ins };
    if (off < end) return { start, end: end + ins };
    return span;
  }

  // 2. Deletion/replacement entirely before or entirely after the span.
  if (delEnd <= start) return { start: start + delta, end: end + delta };
  if (off >= end) return span;

  // 3. The edited region swallows the whole span.
  if (off <= start && delEnd >= end) {
    if (quote && ins >= quote.length) {
      const idx = findQuote(ch.text, quote, start - off);
      if (idx >= 0) return { start: off + idx, end: off + idx + quote.length };
    }
    // Exactly the commented text was replaced: the comment moves onto the replacement.
    if (off === start && delEnd === end) return { start: off, end: off + ins };
    return { start: off, end: off };
  }

  // 4. Partial overlaps.
  if (off <= start) return { start: off, end: end + delta }; // overlaps the start
  if (delEnd <= end) return { start, end: end + delta }; // strictly inside
  return { start, end: off + ins }; // overlaps the end
}

/**
 * Apply all changes of one VS Code change event. Their offsets all refer to the pre-event
 * document and never overlap, so processing them back to front keeps every offset valid.
 */
export function applyChanges(span: Span, changes: readonly Change[], quote = ''): Span {
  const sorted = [...changes].sort((a, b) => b.offset - a.offset);
  return sorted.reduce((s, ch) => transformSpan(s, ch, quote), span);
}

/** Occurrence of `quote` in `text` closest to `hint`, or -1. */
export function findQuote(text: string, quote: string, hint: number): number {
  if (!quote) return -1;
  let best = -1;
  let bestDist = Infinity;
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
    const d = Math.abs(i - hint);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    } else if (i > hint) {
      break; // occurrences only get further away from here on
    }
  }
  return best;
}
