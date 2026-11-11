/**
 * Merge fetched metadata into an entry: fix and fill in fields, keep the citation key and fields
 * only the user has. Edits happen in place, so unchanged fields keep their exact formatting and the
 * diff shows only real changes.
 */
import { fold, lastName, normalizeDoi, splitNames } from './match';
import { BibEntry, BibField, parseEntries, valueText } from './parse';

/** A fetched entry, normalized: lowercase field names, values as plain text (no outer braces). */
export interface Fetched {
  type: string;
  fields: Map<string, { value: string; bare?: boolean }>;
}

export interface MergeOptions {
  /** Fields never changed or removed (lowercase). */
  keepFields: readonly string[];
  /** Fields never taken from a source (lowercase). */
  skipFields: readonly string[];
  /** Do not take a `url` that only repeats the DOI link. */
  skipDoiUrl?: boolean;
}

export interface FieldChange {
  field: string;
  kind: 'changed' | 'added' | 'removed' | 'type';
  from?: string;
  to?: string;
}

export interface MergeResult {
  /** The new text of the entry. */
  text: string;
  changes: FieldChange[];
  /** Fields the source had that were not taken (and would have changed something), and why. */
  skipped: { field: string; reason: 'skipFields' | 'keepFields' | 'skipDoiUrl' }[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PREPRINT_VENUE = /\b(arxiv|corr|biorxiv|medrxiv|ssrn|preprint)\b/i;
const VENUES = ['journal', 'booktitle', 'howpublished'];

/** Read a source's BibTeX (the first entry) into the normalized form `mergeEntry` uses. */
export function readFetched(bibtex: string): Fetched {
  const entry = parseEntries(bibtex)[0];
  if (!entry) throw new Error('the source returned no BibTeX entry');
  const fields = new Map<string, { value: string; bare?: boolean }>();
  for (const f of entry.fields) {
    const name = f.name.toLowerCase();
    if (fields.has(name)) continue;
    const bare = !/^[{"]/.test(f.raw.trim()) && !f.raw.includes('#');
    let value = valueText(f.raw);
    if (name === 'pages') value = value.replace(/\s*[-‐-―]+\s*/g, '--');
    if (name === 'month') {
      const m = monthIndex(value);
      if (m >= 0) {
        fields.set(name, { value: MONTHS[m], bare: true });
        continue;
      }
    }
    fields.set(name, { value, bare: bare && /^\d+$/.test(value) });
  }
  return { type: entry.type.toLowerCase(), fields };
}

/** Merge `fetched` into the entry `entryText` (which must hold exactly one entry). */
export function mergeEntry(entryText: string, fetched: Fetched, options: MergeOptions): MergeResult {
  const entry = parseEntries(entryText)[0];
  if (!entry) throw new Error('not a BibTeX entry');
  const keep = new Set(options.keepFields.map((f) => f.toLowerCase()));
  const skip = new Set(options.skipFields.map((f) => f.toLowerCase()));
  const style = styleOf(entryText, entry);
  const edits: Edit[] = [];
  const changes: FieldChange[] = [];

  const own = new Map<string, BibField>();
  for (const f of entry.fields) if (!own.has(f.name.toLowerCase())) own.set(f.name.toLowerCase(), f);
  // Fields not taken, by the user's settings only. Reported when they would have changed something.
  const skipped: MergeResult['skipped'] = [];
  const doiUrl = (name: string, value: string) =>
    !!options.skipDoiUrl && name === 'url' && fetched.fields.has('doi') && /^https?:\/\/(dx\.)?doi\.org\//i.test(value);
  const incoming = [...fetched.fields].filter(([name, { value }]) => {
    const reason = skip.has(name) ? 'skipFields' : keep.has(name) ? 'keepFields' : doiUrl(name, value) ? 'skipDoiUrl' : undefined;
    const mine = own.get(name);
    if (reason && !(mine && equivalent(name, valueText(mine.raw), value))) skipped.push({ field: name, reason });
    return !reason;
  });

  // Type: @misc{…} → @inproceedings{…}
  if (!keep.has('type') && fetched.type && fetched.type !== entry.type.toLowerCase()) {
    const type = matchCase(fetched.type, entry.type);
    edits.push({ start: entry.typeStart, end: entry.typeStart + entry.type.length, text: type });
    changes.push({ field: 'type', kind: 'type', from: entry.type, to: type });
  }

  // Fields that no longer fit: the preprint venue of a now-published paper, or `journal` when the
  // source says it is a conference paper (and vice versa).
  const removed = new Set<string>();
  const ownVenue = VENUES.map((v) => own.get(v)).filter((f): f is BibField => !!f);
  const wasPreprint = ownVenue.some((f) => PREPRINT_VENUE.test(valueText(f.raw))) || /^abs\//.test(valueText(own.get('volume')?.raw ?? ''));
  const fetchedVenue = VENUES.some((v) => fetched.fields.has(v));
  const fetchedPreprint = VENUES.some((v) => PREPRINT_VENUE.test(fetched.fields.get(v)?.value ?? ''));
  if (fetchedVenue) {
    for (const [name, f] of own) {
      if (keep.has(name) || fetched.fields.has(name)) continue;
      const venueClash = VENUES.includes(name);
      const staleNumbering = wasPreprint && !fetchedPreprint && ['volume', 'number', 'publisher'].includes(name);
      if (venueClash || staleNumbering) {
        removed.add(name);
        edits.push(removal(entryText, f));
        changes.push({ field: f.name, kind: 'removed', from: valueText(f.raw) });
      }
    }
  }

  // Changed and added fields.
  const added: string[] = [];
  for (const [name, fetchedValue] of incoming) {
    const mine = own.get(name);
    const bare = fetchedValue.bare;
    const value = mine && (name === 'author' || name === 'editor') ? inNameStyle(fetchedValue.value, valueText(mine.raw)) : fetchedValue.value;
    if (!mine) {
      added.push(fieldLine(style, name, formatValue(value, bare, undefined)));
      changes.push({ field: name, kind: 'added', to: value });
    } else if (!equivalent(name, valueText(mine.raw), value)) {
      edits.push({ start: mine.valueStart, end: mine.end, text: formatValue(value, bare, mine.raw) });
      changes.push({ field: mine.name, kind: 'changed', from: valueText(mine.raw), to: value });
    }
  }

  if (added.length) {
    const kept = entry.fields.filter((f) => !removed.has(f.name.toLowerCase()));
    const last = kept[kept.length - 1];
    const after = last ? last.end : entry.keyEnd;
    const comma = /^[ \t]*,/.exec(entryText.slice(after));
    const lastOriginal = entry.fields[entry.fields.length - 1];
    const trailingComma = !!lastOriginal && /^\s*,/.test(entryText.slice(lastOriginal.end));
    if (comma && last) {
      const text = added.map((l) => `\n${l}`).join(',') + (trailingComma ? ',' : '');
      edits.push({ start: after + comma[0].length, end: after + comma[0].length, text });
    } else {
      edits.push({ start: after, end: after, text: added.map((l) => `,\n${l}`).join('') });
    }
  }

  return { text: applyEdits(entryText, edits), changes, skipped };
}

/** Same meaning, so the user's version (formatting, case protection) is kept. */
export function equivalent(name: string, mine: string, theirs: string): boolean {
  switch (name) {
    case 'author':
    case 'editor': {
      const a = splitNames(mine).map(lastName);
      const b = splitNames(theirs).map(lastName);
      return a.length === b.length && a.every((n, i) => n === b[i]);
    }
    case 'pages':
      return (mine.match(/\d+/g) ?? []).join('-') === (theirs.match(/\d+/g) ?? []).join('-');
    case 'month':
      return monthIndex(mine) >= 0 && monthIndex(mine) === monthIndex(theirs);
    case 'doi':
      return normalizeDoi(mine) === normalizeDoi(theirs);
    case 'url':
      return mine.replace(/^https?:\/\/|\/$/g, '') === theirs.replace(/^https?:\/\/|\/$/g, '');
    default:
      return fold(mine) === fold(theirs);
  }
}

// ------------------------------------------------------------------ formatting in the entry's style

interface Style {
  indent: string;
  /** Column (from the indent) where values start, when the entry aligns them. */
  valueColumn?: number;
  separator: string;
  capitalize: boolean;
}

function styleOf(text: string, entry: BibEntry): Style {
  const first = entry.fields[0];
  if (!first) return { indent: '  ', separator: ' = ', capitalize: false };
  const lineStart = (offset: number) => text.lastIndexOf('\n', offset - 1) + 1;
  const ls = lineStart(first.start);
  const indent = /^[ \t]*$/.test(text.slice(ls, first.start)) ? text.slice(ls, first.start) : '  ';
  const columns = entry.fields.map((f) => f.valueStart - lineStart(f.valueStart));
  const aligned = entry.fields.length > 1 && columns.every((c) => c === columns[0]);
  return {
    indent,
    valueColumn: aligned ? columns[0] - indent.length : undefined,
    separator: text.slice(first.start + first.name.length, first.valueStart),
    capitalize: /^[A-Z]/.test(first.name),
  };
}

function fieldLine(style: Style, name: string, value: string): string {
  const n = style.capitalize ? name[0].toUpperCase() + name.slice(1) : name;
  if (style.valueColumn !== undefined) {
    const tail = style.separator.trimStart() || '= ';
    return style.indent + n + ' '.repeat(Math.max(1, style.valueColumn - n.length - tail.length)) + tail + value;
  }
  return style.indent + n + style.separator + value;
}

/** In the same delimiters as the value it replaces: `"…"` stays quoted, a bare number stays bare. */
function formatValue(value: string, bare: boolean | undefined, replacing: string | undefined): string {
  const r = replacing?.trim();
  if (bare && (r === undefined || !/^[{"]/.test(r))) return value;
  if (r?.startsWith('"') && !value.includes('"')) return `"${value}"`;
  return `{${value}}`;
}

/**
 * Write fetched names the way the entry already does: `Last, First` or `First Last`. Splits like
 * BibTeX itself (a lowercase "von" part starts the last name), so the meaning never changes.
 */
export function inNameStyle(fetched: string, mine: string): string {
  const myNames = splitNames(mine).filter((n) => n.toLowerCase() !== 'others');
  if (!myNames.length) return fetched;
  const commas = myNames.filter((n) => n.includes(',')).length;
  const wantComma = commas * 2 > myNames.length;
  return splitNames(fetched)
    .map((name) => {
      if (name.toLowerCase() === 'others' || /^\{.*\}$/.test(name)) return name; // institutions: {Google Research}
      if (wantComma && !name.includes(',')) {
        const words = name.split(/\s+/);
        if (words.length < 2) return name;
        let i = words.findIndex((w, k) => k > 0 && k < words.length - 1 && /^[a-z]/.test(w));
        if (i < 0) i = words.length - 1;
        return `${words.slice(i).join(' ')}, ${words.slice(0, i).join(' ')}`;
      }
      if (!wantComma && name.includes(',')) {
        const parts = name.split(',').map((p) => p.trim());
        const last = parts[0].split(/\s+/);
        // "De Roover, Coen" cannot become "Coen De Roover": BibTeX would read the last name as
        // "Roover". A single word, or a lowercase "von" part ("van Bladel"), is safe.
        const safe = parts.length === 2 && (last.length === 1 || /^[a-z]/.test(last[0]));
        return safe ? `${parts[1]} ${parts[0]}` : name;
      }
      return name;
    })
    .join(' and ');
}

function matchCase(word: string, like: string): string {
  if (like === like.toUpperCase()) return word.toUpperCase();
  if (/^[A-Z]/.test(like)) return word[0].toUpperCase() + word.slice(1);
  return word;
}

function monthIndex(value: string): number {
  const v = fold(value);
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return n - 1;
  return MONTHS.indexOf(v.slice(0, 3));
}

// ------------------------------------------------------------------ edits

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Remove a field with its line (or just itself, when it shares the line). */
function removal(text: string, f: BibField): Edit {
  let end = f.end;
  const tail = /^[ \t]*,?[ \t]*(\r?\n)?/.exec(text.slice(end));
  if (tail) end += tail[0].length;
  const ls = text.lastIndexOf('\n', f.start - 1) + 1;
  const ownLine = /^[ \t]*$/.test(text.slice(ls, f.start)) && tail?.[1] !== undefined;
  return { start: ownLine ? ls : f.start, end, text: '' };
}

function applyEdits(text: string, edits: Edit[]): string {
  // From the back, so offsets stay valid; at the same offset, delete before inserting.
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - b.start - (a.end - a.start));
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
