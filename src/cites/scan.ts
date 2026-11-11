/**
 * Find citations and bibliography declarations in LaTeX source. 
 */

export interface Citation {
  key: string;
  /** Offsets of the key itself, for diagnostics and edits. */
  start: number;
  end: number;
}

export interface TexScan {
  citations: Citation[];
  /** `\nocite{*}`: every entry counts as cited. */
  citesAll: boolean;
  /** Bibliography files named by \bibliography / \addbibresource, as written (no .bib added). */
  bibliographies: string[];
}

// \cite, \citep, \citet*, \Textcite, \parencites, \footcite, \citeauthor, \nocite, \bibentry …
const COMMAND = /\\([A-Za-z]*[Cc]ite[A-Za-z]*|bibentry)\*?/g;
/** Commands containing "cite" that do not take citation keys. */
const NOT_CITATIONS = new Set(['citestyle', 'citesetup', 'citetrackerfalse', 'citetrackertrue', 'mancite', 'citereset', 'citeindextrue', 'citeindexfalse']);
const BIBLIOGRAPHY = /\\(?:bibliography|addbibresource|addglobalbib|addsectionbib|nobibliography)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g;

export function scanTex(text: string): TexScan {
  const code = blankComments(text);
  const citations: Citation[] = [];
  let citesAll = false;
  for (const m of code.matchAll(COMMAND)) {
    const name = m[1];
    if (NOT_CITATIONS.has(name.toLowerCase())) continue;
    // biblatex "multicite" commands (\cites, \parencites, …) take several {keys} groups.
    const multi = /cites$/i.test(name);
    let i = m.index! + m[0].length;
    let groups = 0;
    for (;;) {
      const j = skipSpace(code, i);
      const ch = code[j];
      if (ch === '[' || ch === '(') {
        const close = code.indexOf(ch === '[' ? ']' : ')', j);
        if (close < 0) break;
        i = close + 1;
        continue;
      }
      if (ch !== '{' || (groups > 0 && !multi)) break;
      const close = code.indexOf('}', j);
      if (close < 0) break;
      for (const k of keysIn(code, j + 1, close)) {
        if (k.key === '*') citesAll = true;
        else citations.push(k);
      }
      groups++;
      i = close + 1;
    }
  }
  const bibliographies: string[] = [];
  for (const m of code.matchAll(BIBLIOGRAPHY)) {
    for (const name of m[1].split(',')) if (name.trim()) bibliographies.push(name.trim());
  }
  return { citations, citesAll, bibliographies };
}

/** `a, b,c` between `from` and `to` → keys with their offsets. */
function keysIn(text: string, from: number, to: number): Citation[] {
  const out: Citation[] = [];
  let start = from;
  for (let i = from; i <= to; i++) {
    if (i === to || text[i] === ',') {
      const raw = text.slice(start, i);
      const key = raw.trim();
      if (key && !/\s/.test(key)) {
        const offset = start + raw.indexOf(key);
        out.push({ key, start: offset, end: offset + key.length });
      }
      start = i + 1;
    }
  }
  return out;
}

/** Replace %-comments by spaces (same length, so offsets stay valid). `\%` is not a comment. */
export function blankComments(text: string): string {
  return text.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, (all, before: string, slashes: string) => before + slashes + ' '.repeat(all.length - before.length - slashes.length));
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}
