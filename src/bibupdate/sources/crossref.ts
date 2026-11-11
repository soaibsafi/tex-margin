/**
 * https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/
 */
import { Candidate, Kind, normalizeDoi } from '../match';
import { Source, SourceContext, doiBibtex, searchWords } from './source';

export interface Work {
  DOI: string;
  type?: string;
  /** Retractions, corrections, … (Crossref + Retraction Watch). */
  'updated-by'?: { DOI: string; type: string; label?: string; source?: string; updated?: { 'date-parts'?: number[][] } }[];
  title?: string[];
  subtitle?: string[];
  author?: { family?: string; given?: string; name?: string }[];
  'container-title'?: string[];
  issued?: { 'date-parts'?: number[][] };
}

const KINDS: Record<string, Kind> = {
  'journal-article': 'journal',
  'proceedings-article': 'conference',
  'posted-content': 'preprint',
  book: 'book',
  'book-chapter': 'book',
  monograph: 'book',
  'edited-book': 'book',
  report: 'other',
  dissertation: 'other',
};

/** Preprint DOIs (arXiv's are DataCite DOIs, unknown to Crossref): search by title instead. */
const NOT_CROSSREF = /^10\.48550\//;

export const crossref: Source = {
  id: 'crossref',
  label: 'Crossref',
  pacing: { 'api.crossref.org': 1050, 'doi.org': 200 },
  secrets: [
    {
      id: 'crossref.plusToken',
      label: 'Crossref Metadata Plus token',
      detail: 'Optional, paid. Most people only need the contact email setting.',
      url: 'https://www.crossref.org/services/metadata-retrieval/metadata-plus/',
    },
  ],

  async search(q, ctx) {
    if (q.doi && !NOT_CROSSREF.test(q.doi)) {
      try {
        const data = await ctx.http.json<{ message: Work }>(api(`works/${encodeURIComponent(q.doi)}`, ctx), options(ctx));
        return toCandidates([data.message]);
      } catch {
        // A wrong DOI: fall through to the title search.
      }
    }
    if (!q.title) return [];
    const words = `${searchWords(q.title)} ${q.authors[0] ?? ''}`.trim();
    const data = await ctx.http.json<{ message: { items: Work[] } }>(
      api(`works?query.bibliographic=${encodeURIComponent(words)}&rows=10&select=DOI,title,subtitle,author,type,container-title,issued`, ctx),
      options(ctx),
    );
    return toCandidates(data.message.items);
  },

  bibtex: (c, ctx) => doiBibtex(c.id, ctx),

  adjust(fetched) {
    // Crossref puts the conference acronym ("ESEC/FSE '22") in both `series` and `collection`;
    // that is not a series. (`collection` itself is in the default skipFields.)
    const collection = fetched.fields.get('collection')?.value;
    if (collection && fetched.fields.get('series')?.value === collection) fetched.fields.delete('series');
  },
};

/** One Crossref record by DOI (with the user's email / Plus token, like every Crossref request). */
export async function crossrefWork(doi: string, ctx: SourceContext): Promise<Work> {
  const data = await ctx.http.json<{ message: Work }>(api(`works/${encodeURIComponent(doi)}`, ctx), options(ctx));
  return data.message;
}

function api(path: string, ctx: SourceContext): string {
  const url = `https://api.crossref.org/${path}`;
  return ctx.email ? `${url}${path.includes('?') ? '&' : '?'}mailto=${encodeURIComponent(ctx.email)}` : url;
}

function options(ctx: SourceContext) {
  const token = ctx.secret('crossref.plusToken');
  return { signal: ctx.signal, headers: token ? { 'Crossref-Plus-API-Token': `Bearer ${token}` } : undefined };
}

function toCandidates(works: Work[]): Candidate[] {
  return works
    .filter((w) => w.type && w.type in KINDS && w.title?.[0])
    .map((w) => ({
      source: 'crossref',
      id: normalizeDoi(w.DOI),
      title: w.title![0] + (w.subtitle?.[0] ? `: ${w.subtitle[0]}` : ''),
      authors: (w.author ?? []).map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' ')),
      year: w.issued?.['date-parts']?.[0]?.[0],
      venue: w['container-title']?.[0],
      doi: normalizeDoi(w.DOI),
      kind: KINDS[w.type!],
      url: `https://doi.org/${normalizeDoi(w.DOI)}`,
    }));
}
