/**
 * Only used for entries with an arXiv id; the BibTeX then comes from doi.org. 
 * No key. arXiv asks for at most one request every 3 seconds.
 * https://info.arxiv.org/help/api/user-manual.html
 */
import { Candidate, normalizeDoi } from '../match';
import { Source, doiBibtex } from './source';

export const arxiv: Source = {
  id: 'arxiv',
  label: 'arXiv',
  pacing: { 'export.arxiv.org': 3000, 'doi.org': 200 },

  async search(q, ctx) {
    if (!q.arxivId) return [];
    const res = await ctx.http.get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(q.arxivId)}`, { signal: ctx.signal });
    const record = parseArxiv(res.text);
    // Without a published DOI there is nothing to link to (journal_ref alone gives no BibTeX).
    if (!record?.doi || /^10\.48550\//.test(record.doi)) return [];
    const candidate: Candidate = {
      source: 'arxiv',
      id: record.doi,
      title: record.title,
      authors: record.authors,
      year: record.year,
      venue: record.journalRef,
      doi: record.doi,
      kind: 'other', // published (journal or proceedings; the BibTeX says which)
      url: `https://doi.org/${record.doi}`,
    };
    return [candidate];
  },

  bibtex: (c, ctx) => doiBibtex(c.id, ctx),
};

export interface ArxivRecord {
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  journalRef?: string;
}

/** The first <entry> of an arXiv API (Atom) response. */
export function parseArxiv(xml: string): ArxivRecord | undefined {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  if (!entry || !/<id>https?:\/\/arxiv\.org\/abs\//.test(entry)) return undefined;
  const tag = (name: string) => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
    return m ? decode(m[1]).replace(/\s+/g, ' ').trim() : undefined;
  };
  const doi = tag('arxiv:doi');
  return {
    title: tag('title') ?? '',
    authors: [...entry.matchAll(/<author>\s*<name>([^<]*)<\/name>/g)].map((m) => decode(m[1]).trim()),
    year: Number(tag('published')?.slice(0, 4)) || undefined,
    doi: doi ? normalizeDoi(doi) : undefined,
    journalRef: tag('arxiv:journal_ref'),
  };
}

function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e] ?? _);
}
