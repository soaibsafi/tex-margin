/**
 * Deciding whether a search result is the paper a BibTeX entry describes.
 * Rules adapted from Zotero-meta-update (https://github.com/lizeyan/Zotero-meta-update):
 * DOI first, else title + first author; prefer the formal publication over a preprint.
 */
import { BibEntry, fieldMap } from './parse';

export type Kind = 'journal' | 'conference' | 'preprint' | 'book' | 'other';

/** One search result, in the same shape for every source. */
export interface Candidate {
  /** Source id, e.g. `dblp`. */
  source: string;
  /** Source-specific id used to fetch its BibTeX (DBLP key, DOI, …). */
  id: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  kind: Kind;
  /** A page about it, for the user to check. */
  url?: string;
}

/** What we know about the entry to look up. */
export interface Query {
  key: string;
  title?: string;
  doi?: string;
  /** Normalized last names, in order. */
  authors: string[];
  year?: number;
  /** The entry looks like a preprint (arXiv, CoRR, …): a formal version is an upgrade. */
  preprint: boolean;
  /** The author list ends in "and others". */
  moreAuthors: boolean;
  /** arXiv identifier, e.g. `2402.06624`, from eprint, url, DOI or journal. */
  arxivId?: string;
}

const PREPRINT = /\b(arxiv|corr|biorxiv|medrxiv|ssrn|preprint)\b/i;
/** DOIs of preprint servers: the formal version, if any, has a different DOI. */
const PREPRINT_DOI = /^10\.(48550|1101|2139|20944|31219|31234|36227)\//;

export function queryOf(entry: BibEntry): Query {
  const f = fieldMap(entry);
  const doi = f.get('doi') ? normalizeDoi(f.get('doi')!) : undefined;
  const venue = [f.get('journal'), f.get('booktitle'), f.get('howpublished'), f.get('publisher'), f.get('note'), f.get('archiveprefix'), f.get('eprinttype')].join(' ');
  const names = splitNames(f.get('author') ?? '');
  return {
    key: entry.key,
    title: f.get('title') ? plain(f.get('title')!) : undefined,
    doi,
    authors: names.map(lastName).filter((n) => n && n !== 'others'),
    moreAuthors: names.some((n) => n.toLowerCase() === 'others'),
    year: Number(f.get('year')) || undefined,
    preprint: PREPRINT.test(venue) || (!!doi && PREPRINT_DOI.test(doi)) || /^abs\//.test(f.get('volume') ?? ''),
    arxivId: arxivIdOf(f),
  };
}

const ARXIV_ID = /(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i;

/** `eprint = {2402.06624}` (arXiv), `url = {https://arxiv.org/abs/2402.06624v2}`, `doi = {10.48550/arXiv.2402.06624}`, `journal = {arXiv preprint arXiv:2402.06624}`. */
export function arxivIdOf(f: Map<string, string>): string | undefined {
  const archive = `${f.get('archiveprefix') ?? ''} ${f.get('eprinttype') ?? ''}`;
  const candidates = [
    /arxiv/i.test(archive) ? f.get('eprint') : undefined,
    /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/i.exec(f.get('url') ?? '')?.[1],
    /^10\.48550\/arxiv\.(.+)$/i.exec(normalizeDoi(f.get('doi') ?? ''))?.[1],
    /arxiv:\s*(\S+)/i.exec(`${f.get('journal') ?? ''} ${f.get('note') ?? ''} ${f.get('howpublished') ?? ''}`)?.[1],
  ];
  for (const c of candidates) {
    const m = c ? ARXIV_ID.exec(c) : null;
    if (m) return m[1];
  }
  return undefined;
}

// ------------------------------------------------------------------ normalization

/** LaTeX → plain text: `{\"u}ber {GPU}s` → `über GPUs`. */
export function plain(s: string): string {
  return s
    .replace(/\\([`'^"~=.])\s*\{?\s*([A-Za-z])\s*\}?/g, (_, acc: string, ch: string) => ch + (ACCENTS[acc] ?? ''))
    .replace(/\\[uvHtcdbrk]\s*\{\s*([A-Za-z])\s*\}/g, '$1')
    .replace(/\\(ss|ae|oe|aa|o|l)\b\s*/gi, (_, c: string) => ({ ss: 'ss', ae: 'ae', oe: 'oe', aa: 'a', o: 'o', l: 'l' })[c.toLowerCase()] ?? c)
    .replace(/\\&/g, '&')
    .replace(/\\[a-zA-Z]+\s*/g, '')
    .replace(/[{}]/g, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}
const ACCENTS: Record<string, string> = { '`': '̀', "'": '́', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇' };

/** For comparing: plain, no accents, lowercase, words separated by single spaces. */
export function fold(s: string): string {
  return plain(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase();
}

export function splitNames(authors: string): string[] {
  return authors
    .split(/\s+and\s+/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

/** `Vaswani, Ashish` / `Ashish Vaswani` / `Ashish Vaswani 0001` → `vaswani`. */
export function lastName(name: string): string {
  const n = name.replace(/\s+\d{4}$/, '');
  const last = n.includes(',') ? n.split(',')[0] : n.trim().split(/\s+/).pop() ?? '';
  return fold(last).replace(/\s+/g, '');
}

/** 1 − normalized edit distance. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

export function titleSimilarity(a: string, b: string): number {
  const x = fold(a);
  const y = fold(b);
  const s = similarity(x, y);
  // One title is the other plus a subtitle ("Foo" vs "Foo: A Study of Bar").
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 20 && long.startsWith(short + ' ')) return Math.max(s, 0.9);
  return s;
}

// ------------------------------------------------------------------ choosing

export interface Scored {
  candidate: Candidate;
  score: number;
  doiMatch: boolean;
  /** Not the same title: same authors, published later, most title words shared. Needs the user's OK. */
  revised?: boolean;
}

const TITLE_MATCH = 0.9;
/** Share of title words needed for a "revised title" match (with identical authors). */
const REVISED_WORDS = 0.6;

/** Dice coefficient of the title words: how many words two titles share. */
export function wordOverlap(a: string, b: string): number {
  const x = new Set(fold(a).split(' ').filter(Boolean));
  const y = new Set(fold(b).split(' ').filter(Boolean));
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return (2 * common) / (x.size + y.size);
}

/** How well `c` matches `q`, or undefined if it is not the same paper. */
export function score(q: Query, c: Candidate): Scored | undefined {
  const doiMatch = !!q.doi && !!c.doi && normalizeDoi(c.doi) === q.doi;
  const t = q.title ? titleSimilarity(q.title, c.title) : 0;
  if (doiMatch && (!q.title || t >= 0.6)) return { candidate: c, score: 1, doiMatch };
  const cAuthors = c.authors.map(lastName);
  if (t >= TITLE_MATCH) {
    if (q.authors.length && cAuthors.length && !cAuthors.includes(q.authors[0])) return undefined;
    const yearBonus = q.year && c.year && Math.abs(q.year - c.year) <= 1 ? 0.02 : 0;
    return { candidate: c, score: Math.min(0.99, t * 0.97 + yearBonus), doiMatch };
  }
  // A preprint published under a revised title ("… Novice Users …" → "… Users … in Alloy"):
  // only with the very same authors, published the same year or up to two years later, and most
  // title words still shared. Never picked automatically.
  if (!q.preprint || c.kind === 'preprint' || !q.title || !q.authors.length) return undefined;
  const sameAuthors = q.moreAuthors
    ? q.authors.every((a, i) => cAuthors[i] === a)
    : cAuthors.length === q.authors.length && q.authors.every((a, i) => cAuthors[i] === a);
  const inTime = !q.year || !c.year || (c.year >= q.year && c.year <= q.year + 2);
  const overlap = Math.max(t, wordOverlap(q.title, c.title));
  if (!sameAuthors || !inTime || overlap < REVISED_WORDS) return undefined;
  return { candidate: c, score: 0.5 * overlap, doiMatch, revised: true };
}

export type Choice = { pick: Candidate } | { ambiguous: Candidate[]; revised?: boolean } | { none: true };

/**
 * One confident match, several to choose from, or none. A formal publication wins over a preprint
 * of the same paper (also when the entry has the preprint's DOI): that is the update people want.
 */
export function choose(q: Query, candidates: readonly Candidate[]): Choice {
  const scored = candidates
    .map((c) => score(q, c))
    .filter((s): s is Scored => !!s)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { none: true };
  const exact = scored.find((s) => s.doiMatch && s.candidate.kind !== 'preprint');
  if (exact) return { pick: exact.candidate };
  const strong = scored.filter((s) => !s.revised);
  const formal = strong.filter((s) => s.candidate.kind !== 'preprint');
  // No published version under the same title, but maybe under a revised one: ask.
  const revised = scored.filter((s) => s.revised);
  if (!formal.length && revised.length) return { ambiguous: revised.map((s) => s.candidate), revised: true };
  if (!strong.length) return { none: true };
  const pool = formal.length ? formal : strong;
  const distinct = new Map<string, Candidate>();
  for (const s of pool) {
    const id = s.candidate.doi ? normalizeDoi(s.candidate.doi) : `${fold(s.candidate.title)}|${s.candidate.year ?? ''}|${s.candidate.kind}`;
    if (!distinct.has(id)) distinct.set(id, s.candidate);
  }
  const unique = [...distinct.values()];
  return unique.length === 1 ? { pick: unique[0] } : { ambiguous: unique };
}
