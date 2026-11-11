/**
 * Layer 3: map anchors from an old version of a file to a new one by diffing the two texts and
 * pushing every span through the resulting edits. Pure module (no `vscode`), unit-tested.
 */
import { createHash } from 'crypto';
import DiffMatchPatch from 'diff-match-patch';
import { Change, Span, applyChanges, findQuote } from './anchor';

/**
 * Git's blob id for `text` (`git hash-object`). Using it as the anchor hash means a committed
 * version of the file can be fetched back with `git cat-file blob <hash>`.
 */
export function gitBlobHash(text: string): string {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

/** The edits turning `oldText` into `newText`, in `oldText` offsets, non-overlapping. */
export function diffChanges(oldText: string, newText: string, timeoutSec = 2): Change[] {
  if (oldText === newText) return [];
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = timeoutSec;
  const diffs = dmp.diff_main(oldText, newText, true); // line-mode speedup, then char-level refinement
  dmp.diff_cleanupSemantic(diffs);

  const out: Change[] = [];
  let pos = 0;
  let cur: Change | undefined;
  for (const [op, chunk] of diffs) {
    if (op === 0) {
      if (cur) out.push(cur);
      cur = undefined;
      pos += chunk.length;
      continue;
    }
    cur ??= { offset: pos, deleteLength: 0, text: '' };
    if (op === -1) {
      cur.deleteLength += chunk.length;
      pos += chunk.length;
    } else {
      cur.text += chunk;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Split large replacements in a live edit (an external reload, a formatter, pasting over a block)
 * into the finer edits a diff finds inside them, so anchors in unchanged parts stay put.
 */
export function refineChanges(oldText: string, changes: readonly Change[], minSize = 80): Change[] {
  const out: Change[] = [];
  for (const ch of changes) {
    if (ch.deleteLength > 0 && ch.text.length > 0 && ch.deleteLength + ch.text.length >= minSize) {
      const before = oldText.slice(ch.offset, ch.offset + ch.deleteLength);
      for (const sub of diffChanges(before, ch.text, 0.5)) out.push({ ...sub, offset: sub.offset + ch.offset });
    } else {
      out.push(ch);
    }
  }
  return out;
}

/**
 * Map one anchor through `changes` (old to new text). If the commented text vanished from its
 * place (deleted, or moved elsewhere), look for it in the new text. Otherwise keep it collapsed at
 * the point where it was.
 */
export function remap(newText: string, changes: readonly Change[], span: Span, quote: string): Span {
  const mapped = applyChanges(span, changes, quote);
  if (mapped.end > mapped.start) {
    // A diff is ambiguous where an edit touches the edge of the comment (deleting "}" next to a
    // "}" can be read either way). If the exact quote sits right there, prefer it.
    if (quote && newText.slice(mapped.start, mapped.end) !== quote) {
      const near = findQuote(newText, quote, mapped.start);
      if (near >= 0 && Math.abs(near - mapped.start) <= Math.max(16, quote.length)) {
        return { start: near, end: near + quote.length };
      }
    }
    return mapped;
  }
  return locate(newText, quote, mapped.start) ?? mapped;
}

/**
 * Find `quote` in `text` when there are no edits to replay (the last resort):
 *  1. exact match closest to `hint`;
 *  2. fuzzy match (Bitap), accepted only when the found text is at least 75% similar.
 */
export function locate(text: string, quote: string, hint: number): Span | undefined {
  if (!quote) return undefined;
  const exact = findQuote(text, quote, hint);
  if (exact >= 0) return { start: exact, end: exact + quote.length };

  if (quote.length < 4) return undefined; // too short to match fuzzily without false hits
  const dmp = new DiffMatchPatch();
  dmp.Match_Threshold = 0.3;
  dmp.Match_Distance = Math.max(1000, text.length); // position matters little; content does
  const pattern = quote.slice(0, dmp.Match_MaxBits);
  const at = dmp.match_main(text, pattern, Math.max(0, Math.min(hint, text.length)));
  if (at < 0) return undefined;
  const candidate = text.slice(at, at + quote.length);
  const distance = dmp.diff_levenshtein(dmp.diff_main(quote, candidate));
  if (distance / quote.length > 0.25) return undefined;
  return { start: at, end: at + candidate.length };
}
