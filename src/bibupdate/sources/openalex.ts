import { Candidate, Kind, normalizeDoi } from '../match';
import { Source, doiBibtex, searchWords } from './source';

interface Work {
  doi?: string | null;
  title?: string | null;
  publication_year?: number;
  type?: string;
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: { source?: { display_name?: string; type?: string } | null } | null;
}

export const openalex: Source = {
  id: 'openalex',
  label: 'OpenAlex',
  pacing: { 'api.openalex.org': 150, 'doi.org': 200 },
  secrets: [
    {
      id: 'openalex.apiKey',
      label: 'OpenAlex API key',
      detail: 'Free. Without it, OpenAlex allows only a few requests per day, shared by your whole network.',
      url: 'https://openalex.org/settings/api',
    },
  ],

  async search(q, ctx) {
    const filter = q.doi ? `doi:${q.doi}` : q.title ? `title.search:${searchWords(q.title)}` : undefined;
    if (!filter) return [];
    const key = ctx.secret('openalex.apiKey');
    const url =
      `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&per_page=10` +
      '&select=doi,title,publication_year,type,authorships,primary_location' +
      (key ? `&api_key=${encodeURIComponent(key)}` : '');
    let data: { results?: Work[] };
    try {
      data = await ctx.http.json(url, { signal: ctx.signal });
    } catch (e) {
      if ((e as { status?: number }).status === 429 && !key) {
        throw new Error('the free shared OpenAlex budget is used up. Add a free API key with "TeX Margin: Set Metadata API Key…"');
      }
      throw e;
    }
    return (data.results ?? []).filter((w) => w.doi && w.title).map(toCandidate);
  },

  bibtex: (c, ctx) => doiBibtex(c.id, ctx),
};

function toCandidate(w: Work): Candidate {
  const doi = normalizeDoi(w.doi!);
  const source = w.primary_location?.source;
  let kind: Kind = 'other';
  if (w.type === 'preprint' || source?.type === 'repository') kind = 'preprint';
  else if (source?.type === 'conference' || w.type === 'conference-paper') kind = 'conference';
  else if (source?.type === 'journal') kind = 'journal';
  else if (w.type === 'book' || w.type === 'book-chapter') kind = 'book';
  return {
    source: 'openalex',
    id: doi,
    title: w.title!,
    authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
    year: w.publication_year,
    venue: source?.display_name,
    doi,
    kind,
    url: `https://doi.org/${doi}`,
  };
}
