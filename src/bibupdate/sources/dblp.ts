/**
 * Search: https://dblp.org/faq/How+to+use+the+dblp+search+API.html
 * dblp.org can also refuse connections from a network for a while.
 */
import { HttpError } from '../http';
import { Candidate, Kind, lastName, titleSimilarity } from '../match';
import { Source, SourceContext, searchWords } from './source';

interface Hit {
  info: {
    title: string;
    authors?: { author: Author | Author[] };
    venue?: string | string[];
    year?: string;
    type?: string;
    key: string;
    doi?: string;
  };
}
type Author = string | { text: string };

const KINDS: Record<string, Kind> = {
  'Journal Articles': 'journal',
  'Conference and Workshop Papers': 'conference',
  'Informal and Other Publications': 'preprint',
  'Informal Publications': 'preprint',
  'Books and Theses': 'book',
  'Parts in Books or Collections': 'book',
};

export const dblp: Source = {
  id: 'dblp',
  label: 'DBLP',
  pacing: { 'dblp.org': 1100, 'dblp.uni-trier.de': 1100 },

  async search(q, ctx) {
    if (!q.title) return [];
    // Title + first author narrows dblp's prefix search a lot ("Attention is all you need" alone
    // has 120 hits); fall back to the title alone when that finds nothing.
    const queries = q.authors[0] ? [`${searchWords(q.title)} ${q.authors[0]}`, searchWords(q.title)] : [searchWords(q.title)];
    let hits: Candidate[] = [];
    for (const query of queries) {
      hits = await searchDblp(query, ctx);
      if (hits.length) break;
    }
    // A preprint may have been published under a revised title, which a title search cannot find
    // (dblp needs every word). The authors' publication list can; matching then decides (and asks).
    const publishedFound = hits.some((c) => c.kind !== 'preprint' && titleSimilarity(q.title!, c.title) >= 0.9);
    if (q.preprint && q.authors.length && !publishedFound) {
      const byAuthors = await searchDblp(q.authors.slice(0, 3).join(' '), ctx, 100);
      hits = [...hits, ...byAuthors.filter((c) => !hits.some((h) => h.id === c.id))];
    }
    return hits;
  },

  async bibtex(c, ctx) {
    const res = await withMirror((host) => ctx.http.get(`https://${host}/rec/${c.id}.bib?app=${ctx.appId}`, { signal: ctx.signal }));
    if (!res.text.trim().startsWith('@')) throw new Error(/not a bot/i.test(res.text) ? "dblp's bot check blocked the request" : 'dblp returned no BibTeX');
    return res.text;
  },
};

/** dblp.org first; its mirror when dblp.org does not answer or rate-limits. Remembers what worked. */
const HOSTS = ['dblp.org', 'dblp.uni-trier.de'];
let preferred = HOSTS[0];

async function withMirror<T>(request: (host: string) => Promise<T>): Promise<T> {
  const order = [preferred, ...HOSTS.filter((h) => h !== preferred)];
  let error: unknown;
  for (const host of order) {
    try {
      const result = await request(host);
      preferred = host;
      return result;
    } catch (e) {
      const retry = e instanceof HttpError && (e.unreachable || e.status === 429 || (e.status ?? 0) >= 500);
      if (!retry) throw e;
      error = e;
    }
  }
  throw error;
}

async function searchDblp(query: string, ctx: SourceContext, max = 30): Promise<Candidate[]> {
  const path = `/search/publ/api?q=${encodeURIComponent(query)}&format=json&h=${max}&app=${ctx.appId}`;
  const data = await withMirror((host) => ctx.http.json<{ result?: { hits?: { hit?: Hit | Hit[] } } }>(`https://${host}${path}`, { signal: ctx.signal }));
  const hits = ([] as Hit[]).concat(data.result?.hits?.hit ?? []);
  return hits
    .filter((h) => h.info.type !== 'Editorship')
    .map((h): Candidate => {
      const authors = ([] as Author[]).concat(h.info.authors?.author ?? []).map((a) => (typeof a === 'string' ? a : a.text));
      return {
        source: 'dblp',
        id: h.info.key,
        title: decode(h.info.title).replace(/\.$/, ''),
        authors: authors.map((a) => decode(a).replace(/\s+\d{4}$/, '')),
        year: Number(h.info.year) || undefined,
        venue: ([] as string[]).concat(h.info.venue ?? []).join(', ') || undefined,
        doi: h.info.doi,
        kind: KINDS[h.info.type ?? ''] ?? 'other',
        url: `https://dblp.org/rec/${h.info.key}`,
      };
    })
    .filter((c) => c.title && c.authors.every((a) => lastName(a)));
}

function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[e] ?? _);
}
