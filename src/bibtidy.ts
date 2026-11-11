/**
 * BibTeX tidying via the `bibtex-tidy` library (https://github.com/FlamingTempura/bibtex-tidy).
 * Pure module (no `vscode`), unit-tested. All formatting rules live upstream; this file only
 * loads the library, passes options through, and keeps the file's line endings.
 */
import type { tidy as upstreamTidy, Warning } from 'bibtex-tidy' with { 'resolution-mode': 'import' };
import { diffChanges } from './diff';

type TidyFn = typeof upstreamTidy;
export type TidyOptions = NonNullable<Parameters<TidyFn>[1]>;
export type TidyWarning = Warning;

/** Options that only make sense for the bibtex-tidy CLI; dropped if someone puts them in settings. */
const CLI_ONLY = ['help', 'version', 'quiet', 'backup', 'modify', 'outputPath', 'v2'];

let loaded: Promise<TidyFn> | undefined;

/**
 * bibtex-tidy is published only as an ES module. With `"module": "node16"` TypeScript keeps this a
 * real `import()` (instead of `require()`), which works from our CommonJS extension.
 */
export function loadTidy(): Promise<TidyFn> {
  polyfill();
  return (loaded ??= import('bibtex-tidy').then((m) => m.tidy));
}

/**
 * bibtex-tidy ≥ 1.15 calls `Map/WeakMap.prototype.getOrInsert` (ES2026). Its CLI and web UI load
 * core-js for that, but the library entry does not, and VS Code's Node does not have it yet.
 * Spec-compliant and only installed when missing.
 */
function polyfill(): void {
  for (const C of [Map, WeakMap] as const) {
    const proto = C.prototype as unknown as Record<string, unknown>;
    if (typeof proto.getOrInsert !== 'function') {
      Object.defineProperty(proto, 'getOrInsert', {
        configurable: true,
        writable: true,
        value(this: Map<unknown, unknown>, key: unknown, value: unknown) {
          if (this.has(key)) return this.get(key);
          this.set(key, value);
          return value;
        },
      });
    }
    if (typeof proto.getOrInsertComputed !== 'function') {
      Object.defineProperty(proto, 'getOrInsertComputed', {
        configurable: true,
        writable: true,
        value(this: Map<unknown, unknown>, key: unknown, compute: (key: unknown) => unknown) {
          if (this.has(key)) return this.get(key);
          const value = compute(key);
          this.set(key, value);
          return value;
        },
      });
    }
  }
}

export interface TidyOutcome {
  /** The tidied text, with the same line endings as the input. */
  text: string;
  changed: boolean;
  warnings: TidyWarning[];
  /** Number of entries after tidying. */
  entries: number;
}

/** Run bibtex-tidy on `text`. Throws (with bibtex-tidy's message) on a syntax error. */
export async function tidyBibtex(text: string, options: TidyOptions = {}, tidy?: TidyFn): Promise<TidyOutcome> {
  const fn = tidy ?? (await loadTidy());
  const crlf = text.includes('\r\n');
  const input = crlf ? text.replace(/\r\n/g, '\n') : text;
  const unclosed = unclosedBrace(input);
  if (unclosed) throw new Error(`the "{" on line ${unclosed} is never closed. Fix it first; tidying now would drop everything after it.`);
  const result = fn(input, cleanOptions(options));
  const out = crlf ? result.bibtex.replace(/\r?\n/g, '\r\n') : result.bibtex;
  return { text: out, changed: out !== text, warnings: result.warnings, entries: result.count };
}

/**
 * Line (1-based) of the outermost `{` that is never closed, or 0. bibtex-tidy does not report this:
 * it silently swallows the rest of the file into that value.
 */
export function unclosedBrace(text: string): number {
  const open: number[] = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') line++;
    else if (ch === '\\') i++; // \{ and \} are literal braces
    else if (ch === '{') open.push(line);
    else if (ch === '}') open.pop(); // stray closing braces are kept by bibtex-tidy as comment text
  }
  return open[0] ?? 0;
}

export function cleanOptions(options: TidyOptions): TidyOptions {
  const out: Record<string, unknown> = { ...options };
  for (const key of CLI_ONLY) delete out[key];
  return out as TidyOptions;
}

export interface LineEdit {
  /** [line, character], zero-based. */
  start: [number, number];
  end: [number, number];
  text: string;
}

/**
 * The minimal edits turning `oldText` into `newText`, as line/character ranges. Computed on `\n`
 * text so a range never splits a `\r\n`; VS Code converts inserted line breaks to the file's EOL.
 * Small edits keep the cursor, undo steps and comment anchors in untouched entries where they are.
 */
export function lineEdits(oldText: string, newText: string): LineEdit[] {
  const a = oldText.replace(/\r\n/g, '\n');
  const b = newText.replace(/\r\n/g, '\n');
  const starts = [0];
  for (let i = a.indexOf('\n'); i >= 0; i = a.indexOf('\n', i + 1)) starts.push(i + 1);
  const pos = (offset: number): [number, number] => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return [lo, offset - starts[lo]];
  };
  return diffChanges(a, b).map((c) => ({ start: pos(c.offset), end: pos(c.offset + c.deleteLength), text: c.text }));
}

/** Use the editor's indentation unless `space`/`tab` are set explicitly. */
export function withIndent(options: TidyOptions, editor?: { insertSpaces: boolean; tabSize: number }): TidyOptions {
  if (!editor || options.space !== undefined || options.tab !== undefined) return options;
  return editor.insertSpaces ? { ...options, space: editor.tabSize } : { ...options, tab: true };
}

/** One line for a notification, e.g. "42 entries · 2 duplicates merged · 1 entry without a key". */
export function summarize(outcome: TidyOutcome, options: TidyOptions): string {
  const count = (code: TidyWarning['code']) => outcome.warnings.filter((w) => w.code === code).length;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts = [n(outcome.entries, 'entry', 'entries')];
  const dups = count('DUPLICATE_ENTRY');
  if (dups) parts.push(options.merge ? `${n(dups, 'duplicate', 'duplicates')} merged` : n(dups, 'possible duplicate', 'possible duplicates'));
  const missing = count('MISSING_KEY');
  if (missing) parts.push(`${n(missing, 'entry', 'entries')} without a key`);
  const escapes = count('UNSUPPORTED_ESCAPE');
  if (escapes) parts.push(`${n(escapes, 'character', 'characters')} could not be escaped`);
  return parts.join(' · ');
}

// ------------------------------------------------------------------ "what to do" picker

/** A switch in the Tidy BibTeX picker. Everything not listed here comes from settings as-is. */
export interface TidyChoice {
  key: keyof TidyOptions & string;
  label: string;
  detail?: string;
  /** Value used when switched on and the settings have no truthy value of their own. */
  on: TidyOptions[keyof TidyOptions];
  /** Whether bibtex-tidy treats an unset option as on. */
  defaultOn?: boolean;
}

export const TIDY_CHOICES: readonly TidyChoice[] = [
  { key: 'sort', label: 'Sort entries', detail: 'By citation key (or the fields in your settings).', on: true },
  { key: 'merge', label: 'Merge duplicate entries', detail: 'Same DOI, key, abstract, or author + title. Keeps the first entry and deletes the others, without updating your \\cite commands. To merge two keys of one paper and update the citations, use the quick fix in the Problems panel.', on: 'combine' },
  { key: 'duplicates', label: 'Report duplicates', detail: 'Only warn about duplicates, without removing them.', on: true },
  { key: 'removeEmptyFields', label: 'Remove empty fields', on: true },
  { key: 'omit', label: 'Remove fields', detail: 'The fields listed in texMargin.bibtexTidy.options.omit.', on: [] },
  { key: 'sortFields', label: 'Sort fields within entries', detail: 'title, author, year, journal, …', on: true },
  { key: 'align', label: 'Align values', on: 14, defaultOn: true },
  { key: 'curly', label: 'Use braces around all values', detail: '"Journal of Tea" → {Journal of Tea}', on: true },
  { key: 'months', label: 'Abbreviate months', detail: 'January → jan', on: true },
  { key: 'blankLines', label: 'Blank line between entries', on: true },
];

export function isOn(options: TidyOptions, choice: TidyChoice): boolean {
  const value = options[choice.key];
  if (value === undefined) return !!choice.defaultOn;
  if (Array.isArray(value)) return choice.key === 'omit' ? value.length > 0 : true;
  return value !== false && value !== 0;
}

/** The choices that are offered for `options` (e.g. "Remove fields" only when fields are configured). */
export function availableChoices(options: TidyOptions): TidyChoice[] {
  return TIDY_CHOICES.filter((c) => c.key !== 'omit' || (Array.isArray(options.omit) && options.omit.length > 0));
}

/** Settings + the switches picked for this run. Picked keys keep their configured value if it is truthy. */
export function applyChoices(options: TidyOptions, offered: readonly TidyChoice[], picked: ReadonlySet<string>): TidyOptions {
  const out: Record<string, unknown> = { ...options };
  for (const c of offered) {
    if (picked.has(c.key)) {
      if (!isOn(options, c) || options[c.key] === undefined) out[c.key] = c.on;
    } else {
      out[c.key] = c.key === 'omit' ? [] : false;
    }
  }
  // Merging needs duplicate detection; `duplicates: false` would silently turn merging into a no-op.
  if (picked.has('merge') && !picked.has('duplicates')) {
    out.duplicates = options.duplicates === false ? undefined : options.duplicates;
  }
  return out as TidyOptions;
}
