import { fold, lastName, normalizeDoi, similarity, splitNames } from '../bibupdate/match';
import { BibEntry, fieldMap, parseEntries } from '../bibupdate/parse';
import { scanTex } from './scan';

export interface SourceFile {
  /** Any stable id (the extension uses the URI string). */
  id: string;
  text: string;
}

export interface Place {
  file: string;
  start: number;
  end: number;
}

export interface BibItem {
  key: string;
  file: string;
  entry: BibEntry;
  /** Offsets of the key in its file. */
  keyStart: number;
  keyEnd: number;
}

export type Finding =
  | { kind: 'missing'; key: string; at: Place; suggestion?: string }
  | { kind: 'unused'; item: BibItem }
  | { kind: 'duplicateKey'; item: BibItem; first: BibItem }
  | { kind: 'samePaper'; item: BibItem; others: BibItem[]; reason: SameReason };

export type SameReason = 'DOI' | 'title, first author and year' | 'DOI, or title, first author and year';

export interface ProjectCheck {
  findings: Finding[];
  /** Every entry by key (the first definition wins, like BibTeX). */
  entries: Map<string, BibItem>;
  /** Where each key is cited. */
  citations: Map<string, Place[]>;
}

export interface CheckOptions {
  reportUnused: boolean;
}

/**
 * Check `tex` files against `bib` files. `bib` should be the bibliographies the documents use
 * (see `bibliographyFiles`), or all .bib files when none are declared.
 */
export function checkProject(tex: readonly SourceFile[], bib: readonly SourceFile[], options: CheckOptions): ProjectCheck {
  const findings: Finding[] = [];
  const entries = new Map<string, BibItem>();
  const all: BibItem[] = [];
  for (const file of bib) {
    for (const entry of parseEntries(file.text)) {
      if (!entry.key) continue;
      const item: BibItem = { key: entry.key, file: file.id, entry, keyStart: entry.keyEnd - entry.key.length, keyEnd: entry.keyEnd };
      all.push(item);
      const first = entries.get(entry.key);
      if (first) findings.push({ kind: 'duplicateKey', item, first });
      else entries.set(entry.key, item);
    }
  }

  const citations = new Map<string, Place[]>();
  let citesAll = false;
  for (const file of tex) {
    const scan = scanTex(file.text);
    citesAll ||= scan.citesAll;
    for (const c of scan.citations) {
      const places = citations.get(c.key) ?? [];
      places.push({ file: file.id, start: c.start, end: c.end });
      citations.set(c.key, places);
    }
  }

  const keys = [...entries.keys()];
  for (const [key, places] of citations) {
    if (entries.has(key)) continue;
    const suggestion = suggest(key, keys);
    for (const at of places) findings.push({ kind: 'missing', key, at, suggestion });
  }

  if (options.reportUnused && !citesAll && tex.length) {
    for (const item of entries.values()) if (!citations.has(item.key)) findings.push({ kind: 'unused', item });
  }

  for (const group of samePaperGroups([...entries.values()])) {
    for (const item of group.items) {
      findings.push({ kind: 'samePaper', item, others: group.items.filter((o) => o !== item), reason: group.reason });
    }
  }
  return { findings, entries, citations };
}

/** The closest existing key, for "did you mean …?" (a typo or a case difference). */
export function suggest(key: string, keys: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = 0.75;
  for (const k of keys) {
    const s = k.toLowerCase() === key.toLowerCase() ? 1 : similarity(k.toLowerCase(), key.toLowerCase());
    if (s > bestScore || (s === bestScore && best === undefined)) {
      best = k;
      bestScore = s;
    }
  }
  return best;
}

/** Entries describing the same paper under different keys: same DOI, or same title + first author + year. */
export function samePaperGroups(items: readonly BibItem[]): { items: BibItem[]; reason: SameReason }[] {
  // Union-find: A and B share a DOI, B and C share title + author + year → one group of three.
  const parent = items.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const byDoi = new Set<number>();
  const link = (id: (f: Map<string, string>) => string | undefined, viaDoi: boolean) => {
    const first = new Map<string, number>();
    items.forEach((item, i) => {
      const k = id(fieldMap(item.entry));
      if (!k) return;
      const j = first.get(k);
      if (j === undefined) first.set(k, i);
      else {
        parent[root(i)] = root(j);
        if (viaDoi) byDoi.add(i).add(j);
      }
    });
  };
  link((f) => (f.get('doi') ? normalizeDoi(f.get('doi')!) : undefined), true);
  link((f) => {
    const title = f.get('title') ? fold(f.get('title')!) : '';
    const author = splitNames(f.get('author') ?? '')[0];
    if (title.length < 12 || !author || !f.get('year')) return undefined;
    return `${title}|${lastName(author)}|${f.get('year')}`;
  }, false);

  const groups = new Map<number, number[]>();
  items.forEach((_, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), i]));
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      // "same DOI" when every key shares it; the mixed wording only when some are linked by title alone.
      const allDoi = g.every((i) => byDoi.has(i));
      const someDoi = g.some((i) => byDoi.has(i));
      const reason: SameReason = allDoi ? 'DOI' : someDoi ? 'DOI, or title, first author and year' : 'title, first author and year';
      return { items: g.map((i) => items[i]), reason };
    });
}

/**
 * The .bib files a document uses: `\bibliography{refs,other}` / `\addbibresource{refs.bib}`,
 * resolved against the .tex file's folder. Returns undefined if the project declares none.
 */
export function declaredBibliographies(tex: readonly SourceFile[], resolve: (texId: string, name: string) => string): Set<string> | undefined {
  const out = new Set<string>();
  for (const file of tex) {
    for (const name of scanTex(file.text).bibliographies) out.add(resolve(file.id, /\.bib$/i.test(name) ? name : `${name}.bib`));
  }
  return out.size ? out : undefined;
}
