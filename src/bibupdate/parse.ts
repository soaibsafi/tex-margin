/**
 * A small BibTeX reader that keeps exact offsets, so an update can rewrite single field values in
 * place and leave everything else byte-for-byte as the user wrote it.
 * TODO: maybe add tidy bibtex parser later
 */

export interface BibField {
  /** As written (case kept). */
  name: string;
  /** The raw value as written: `{Tea}`, `"Tea"`, `2020`, `jan # {~1}`. */
  raw: string;
  /** Offset of the field name. */
  start: number;
  valueStart: number;
  /** Offset just after the value. */
  end: number;
}

export interface BibEntry {
  /** As written, e.g. `Article`. */
  type: string;
  key: string;
  /** Offset of the `@`. */
  start: number;
  /** Offset just after the closing brace (or the end of the text if it is missing). */
  end: number;
  typeStart: number;
  /** Offset just after the citation key. */
  keyEnd: number;
  fields: BibField[];
}

const SKIP = new Set(['comment', 'string', 'preamble']);

export function parseEntries(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  let i = 0;
  while ((i = text.indexOf('@', i)) >= 0) {
    const at = i;
    const typeMatch = /^@\s*([A-Za-z]+)\s*([{(])/.exec(text.slice(at, at + 64));
    if (!typeMatch) {
      i++;
      continue;
    }
    const type = typeMatch[1];
    const typeStart = at + typeMatch[0].indexOf(type);
    const open = at + typeMatch[0].length - 1;
    const close = typeMatch[2] === '{' ? '}' : ')';
    if (SKIP.has(type.toLowerCase())) {
      i = matching(text, open, close);
      continue;
    }
    const entry = parseBody(text, type, at, typeStart, open + 1, close);
    entries.push(entry);
    i = entry.end;
  }
  return entries;
}

/** The entry containing `offset` (between its `@` and closing brace, inclusive). */
export function entryAt(entries: readonly BibEntry[], offset: number): BibEntry | undefined {
  return entries.find((e) => e.start <= offset && offset <= e.end);
}

/** The value of a raw field without delimiters: `{A} # " B"` → `A B`. Macros stay as their name. */
export function valueText(raw: string): string {
  let out = '';
  for (const piece of splitConcat(raw)) {
    if ((piece.startsWith('{') && piece.endsWith('}')) || (piece.startsWith('"') && piece.endsWith('"'))) out += piece.slice(1, -1);
    else out += piece;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Lowercased field name → value text. Later duplicates are ignored, like BibTeX does. */
export function fieldMap(entry: BibEntry): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of entry.fields) if (!map.has(f.name.toLowerCase())) map.set(f.name.toLowerCase(), valueText(f.raw));
  return map;
}

// ------------------------------------------------------------------ internals

function parseBody(text: string, type: string, at: number, typeStart: number, from: number, close: string): BibEntry {
  let i = skipSpace(text, from);
  let keyEnd = i;
  while (keyEnd < text.length && !/[,\s]/.test(text[keyEnd]) && text[keyEnd] !== close) keyEnd++;
  const key = text.slice(i, keyEnd);
  i = keyEnd;
  const fields: BibField[] = [];
  for (;;) {
    i = skipSpace(text, i);
    while (text[i] === ',') i = skipSpace(text, i + 1);
    if (i >= text.length) return { type, key, start: at, end: text.length, typeStart, keyEnd, fields };
    if (text[i] === close) return { type, key, start: at, end: i + 1, typeStart, keyEnd, fields };
    const nameMatch = /^[^\s=,{}()"#]+/.exec(text.slice(i, i + 200));
    const eq = nameMatch ? skipSpace(text, i + nameMatch[0].length) : i;
    if (!nameMatch || text[eq] !== '=') {
      // Not `name = value`: give up on the fields and find the end of the entry.
      const end = matching(text, from - 1, close);
      return { type, key, start: at, end, typeStart, keyEnd, fields };
    }
    const valueStart = skipSpace(text, eq + 1);
    let j = valueStart;
    for (;;) {
      j = pieceEnd(text, j, close);
      const next = skipSpace(text, j);
      if (text[next] !== '#') break;
      j = skipSpace(text, next + 1);
    }
    fields.push({ name: nameMatch[0], raw: text.slice(valueStart, j), start: i, valueStart, end: j });
    i = j;
  }
}

/** End of one value piece starting at `i`: `{…}`, `"…"`, or a bare word/number. */
function pieceEnd(text: string, i: number, close: string): number {
  if (text[i] === '{') return matching(text, i, '}');
  if (text[i] === '"') {
    let depth = 0;
    for (let j = i + 1; j < text.length; j++) {
      const ch = text[j];
      if (ch === '\\') j++;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '"' && depth <= 0) return j + 1;
    }
    return text.length;
  }
  let j = i;
  while (j < text.length && !/[\s,#]/.test(text[j]) && text[j] !== close) j++;
  return j;
}

/** Offset just after the bracket matching the one at `open`. */
function matching(text: string, open: number, close: string): number {
  const opener = text[open];
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') j++;
    else if (ch === opener || (close === ')' && ch === '{')) depth++;
    else if (ch === close || (close === ')' && ch === '}')) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return text.length;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

function splitConcat(raw: string): string[] {
  const pieces: string[] = [];
  let i = 0;
  while (i < raw.length) {
    i = skipSpace(raw, i);
    if (i >= raw.length) break;
    const end = pieceEnd(raw, i, '\0');
    pieces.push(raw.slice(i, end));
    i = skipSpace(raw, end);
    if (raw[i] === '#') i++;
    else break;
  }
  return pieces;
}
