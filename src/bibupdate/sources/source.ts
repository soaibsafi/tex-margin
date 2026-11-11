import { Http } from '../http';
import { Candidate, Query } from '../match';
import { Fetched } from '../merge';

export interface SourceContext {
  http: Http;
  signal?: AbortSignal;
  /** Contact email from the settings (empty if not set). Only sources that ask for it use it. */
  email: string;
  /** Secrets this source declared, by id (e.g. `openalex.apiKey`). */
  secret(id: string): string | undefined;
  /** Identifies this extension, e.g. `texMargin_0.1.0`. */
  appId: string;
}

export interface SourceSecret {
  /** Stored as `texMargin.bibUpdate.<id>` in VS Code's secret storage. */
  id: string;
  label: string;
  detail: string;
  url: string;
}

export interface Source {
  id: string;
  label: string;
  /** Minimum milliseconds between requests, per host. */
  pacing?: Record<string, number>;
  /** Optional API keys, offered by "Set Metadata API Key…". */
  secrets?: SourceSecret[];
  /** Results for the query, in any order; matching happens afterwards. */
  search(q: Query, ctx: SourceContext): Promise<Candidate[]>;
  /** The candidate's BibTeX. */
  bibtex(c: Candidate, ctx: SourceContext): Promise<string>;
  /**
   * Fix data this source is known to get wrong. Not for removing fields people may want: that is
   * `texMargin.bibUpdate.skipFields`, which the user controls.
   */
  adjust?(fetched: Fetched): void;
}

/** Words of a title for a full-text search (punctuation can break query syntaxes). */
export function searchWords(title: string): string {
  return title
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** BibTeX for any DOI (Crossref, DataCite incl. arXiv, mEDRA) via doi.org content negotiation. */
export async function doiBibtex(doi: string, ctx: SourceContext): Promise<string> {
  const res = await ctx.http.get(`https://doi.org/${encodeURIComponent(doi).replace(/%2F/g, '/')}`, {
    headers: { Accept: 'application/x-bibtex; charset=utf-8' },
    signal: ctx.signal,
  });
  if (!res.text.trim().startsWith('@')) throw new Error(`doi.org returned no BibTeX for ${doi}`);
  return res.text;
}
