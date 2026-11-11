import { HttpError } from '../bibupdate/http';
import { crossrefWork } from '../bibupdate/sources/crossref';
import { SourceContext } from '../bibupdate/sources/source';

export type Status = 'retracted' | 'concern' | 'corrected';

export interface Notice {
  status: Status;
  /** As Crossref labels it, e.g. "Retraction", "Expression of concern". */
  label: string;
  year?: number;
  /** DOI of the notice itself. */
  doi: string;
  source?: string;
}

const RETRACTED = new Set(['retraction', 'partial_retraction', 'withdrawal', 'removal']);
const CONCERN = new Set(['expression_of_concern']);
const CORRECTED = new Set(['correction', 'erratum', 'corrigendum', 'addendum', 'clarification']);

/** The notices that matter, most serious first. A later reinstatement cancels a retraction. */
export function noticesOf(updatedBy: readonly { DOI: string; type: string; label?: string; source?: string; updated?: { 'date-parts'?: number[][] } }[] = []): Notice[] {
  const year = (u: (typeof updatedBy)[number]) => u.updated?.['date-parts']?.[0]?.[0];
  const reinstated = Math.max(0, ...updatedBy.filter((u) => u.type.toLowerCase() === 'reinstatement').map((u) => year(u) ?? 0));
  const out: Notice[] = [];
  for (const u of updatedBy) {
    const type = u.type.toLowerCase();
    const status: Status | undefined = RETRACTED.has(type) ? 'retracted' : CONCERN.has(type) ? 'concern' : CORRECTED.has(type) ? 'corrected' : undefined;
    if (!status) continue;
    if (status === 'retracted' && reinstated && (year(u) ?? 0) <= reinstated) continue;
    out.push({ status, label: u.label ?? type.replace(/_/g, ' '), year: year(u), doi: u.DOI, source: u.source });
  }
  const rank: Record<Status, number> = { retracted: 0, concern: 1, corrected: 2 };
  return out.sort((a, b) => rank[a.status] - rank[b.status]);
}

export interface RetractionResult {
  /** DOI → notices (only DOIs that have any). */
  notices: Map<string, Notice[]>;
  checked: number;
  /** DOIs Crossref does not know (often DataCite DOIs, e.g. arXiv) or that failed, with why. */
  unchecked: { doi: string; reason: string }[];
}

export async function checkRetractions(dois: readonly string[], ctx: SourceContext, progress?: (done: number) => void): Promise<RetractionResult> {
  const result: RetractionResult = { notices: new Map(), checked: 0, unchecked: [] };
  for (const [i, doi] of dois.entries()) {
    ctx.signal?.throwIfAborted();
    progress?.(i);
    try {
      const work = await crossrefWork(doi, ctx);
      result.checked++;
      const notices = noticesOf(work['updated-by']);
      if (notices.length) result.notices.set(doi, notices);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      const reason = e instanceof HttpError && e.status === 404 ? 'not a Crossref DOI' : e instanceof Error ? e.message : String(e);
      result.unchecked.push({ doi, reason });
    }
  }
  return result;
}
