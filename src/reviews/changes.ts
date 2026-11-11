import { diffChanges } from '../diff';

export interface Excerpt {
  /** The paragraph as it is now (LaTeX source). */
  text: string;
  /** 1-based line where it starts. */
  line: number;
}

const MAX = 1500;

/** The changed paragraph around [start, end) of `current`, or undefined if it is unchanged. */
export function changedExcerpt(submitted: string, current: string, start: number, end: number): Excerpt | undefined {
  const para = paragraphAround(current, start, end);
  if (!touches(diffChanges(submitted, current), para.start, para.end)) return undefined;
  let { start: s, end: e } = para;
  // A heading or label line right before or after the text ("\section{Evaluation}" with no blank
  // line after it) is not part of the revised text.
  const heading = /^[ \t]*\\(part|chapter|(sub)*section|paragraph|label)\*?(\[[^\]]*\])?\{[^\n]*\}[ \t]*(%[^\n]*)?$/;
  for (;;) {
    const nl = current.indexOf('\n', s);
    if (nl < 0 || nl >= e || nl + 1 > start || !heading.test(current.slice(s, nl))) break;
    s = nl + 1;
  }
  for (;;) {
    const trimmedEnd = current.slice(s, e).replace(/\s+$/, '').length + s;
    const ls = current.lastIndexOf('\n', trimmedEnd - 1) + 1;
    if (ls <= s || ls < end || !heading.test(current.slice(ls, trimmedEnd))) break;
    e = ls;
  }
  if (e - s > MAX) {
    // A huge "paragraph" (no blank lines): keep the part around the anchor, at line boundaries.
    s = Math.max(s, current.lastIndexOf('\n', Math.max(s, start - MAX / 2)) + 1);
    e = Math.min(e, nextLineEnd(current, Math.min(e, end + MAX / 2)));
  }
  return { text: current.slice(s, e).trim(), line: current.slice(0, s).split('\n').length };
}

/** Lines between the blank lines around [start, end). */
export function paragraphAround(text: string, start: number, end: number): { start: number; end: number } {
  const blank = /\n[ \t]*\n/g;
  let s = 0;
  let e = text.length;
  for (const m of text.matchAll(blank)) {
    const after = m.index! + m[0].length;
    if (after <= start) s = after;
    else if (m.index! >= end) {
      e = m.index!;
      break;
    }
  }
  return { start: s, end: e };
}

/** Does any edit (old offsets) land in [start, end] of the new text? */
function touches(changes: readonly { offset: number; deleteLength: number; text: string }[], start: number, end: number): boolean {
  let delta = 0;
  for (const c of changes) {
    const newStart = c.offset + delta;
    const newEnd = newStart + c.text.length;
    if (newStart <= end && newEnd >= start) return true;
    delta += c.text.length - c.deleteLength;
  }
  return false;
}

function nextLineEnd(text: string, i: number): number {
  const n = text.indexOf('\n', i);
  return n < 0 ? text.length : n;
}

/**
 * Can this LaTeX be pasted into the letter as is? Balanced braces and \begin/\end, no
 * sectioning or labels that would clash with the letter.
 */
export function safeLatex(text: string): boolean {
  const code = text.replace(/\\[{}%]/g, '').replace(/%.*$/gm, '');
  let depth = 0;
  for (const ch of code) {
    if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) return false;
  }
  if (depth !== 0) return false;
  const stack: string[] = [];
  for (const m of code.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) {
    if (m[1] === 'begin') stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  if (stack.length) return false;
  return !/\\(section|subsection|subsubsection|chapter|label|input|include|bibliography|documentclass|usepackage)\b/.test(code);
}
