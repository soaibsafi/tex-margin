/**
 * Find published versions of the preprints in a .bib file
 * The Update Entry Metadata lookup, run for every entry that looks like a preprint, keeping only results that are the published version.
 */
import { MergeOptions } from '../bibupdate/merge';
import { Candidate, queryOf } from '../bibupdate/match';
import { BibEntry, parseEntries } from '../bibupdate/parse';
import { Source, SourceContext } from '../bibupdate/sources';
import { Found, lookup } from '../bibupdate/update';

export interface PreprintResult {
  /** The .bib text with every published version merged in. */
  proposed: string;
  published: { key: string; found: Found }[];
  /** Several plausible matches: needs Update Entry Metadata on that entry. */
  ambiguous: string[];
  /** No published version found (yet). */
  unpublished: string[];
  /** Sources that failed (and were then skipped for the remaining entries). */
  errors: string[];
}

export function preprintEntries(bibText: string): BibEntry[] {
  return parseEntries(bibText).filter((e) => queryOf(e).preprint && (queryOf(e).title || queryOf(e).doi));
}

export async function findPublished(
  bibText: string,
  sources: readonly Source[],
  ctx: SourceContext,
  options: MergeOptions,
  progress: (done: number, total: number, key: string) => void,
  /** Asked for published versions under a changed title (never taken without the user's OK). */
  confirmRevised?: (key: string, candidates: Candidate[], source: Source, yourTitle?: string) => Promise<Candidate | 'next' | undefined>,
): Promise<PreprintResult> {
  const entries = preprintEntries(bibText);
  const result: PreprintResult = { proposed: bibText, published: [], ambiguous: [], unpublished: [], errors: [] };
  let active = [...sources];
  const failures = new Map<Source, number>();
  for (const [i, entry] of entries.entries()) {
    ctx.signal?.throwIfAborted();
    progress(i, entries.length, entry.key);
    const entryText = bibText.slice(entry.start, entry.end);
    const q = queryOf(entry);
    const res = await lookup(entryText, q, active, ctx, options, {
      progress: () => undefined,
      // A revised title is asked about right away; other ambiguity is left to Update Entry Metadata.
      pick: async (candidates, source, revised) => (revised && confirmRevised ? confirmRevised(entry.key, candidates, source, q.title) : undefined),
    });
    // A source that fails twice in a row (offline, blocked, out of budget) is skipped from then on.
    for (const s of active) failures.set(s, res.errors.some((e) => e.source === s) ? (failures.get(s) ?? 0) + 1 : 0);
    for (const e of res.errors) if (failures.get(e.source) === 2) result.errors.push(`${e.source.label}: ${e.message}`);
    active = active.filter((s) => (failures.get(s) ?? 0) < 2);

    if (res.stopped) result.ambiguous.push(entry.key);
    else if (res.found && res.found.candidate.kind !== 'preprint' && res.found.merge.changes.length) result.published.push({ key: entry.key, found: res.found });
    else result.unpublished.push(entry.key);
    if (!active.length) break;
  }
  // Merge from the back, so earlier offsets stay valid.
  const byKey = new Map(result.published.map((p) => [p.key, p.found.merge.text]));
  for (const entry of [...entries].reverse()) {
    const merged = byKey.get(entry.key);
    if (merged !== undefined) result.proposed = result.proposed.slice(0, entry.start) + merged + result.proposed.slice(entry.end);
  }
  return result;
}
