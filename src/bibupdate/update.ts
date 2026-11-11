/**
 * Look up one entry- 
 * try the sources in order, stop at the first confident match, ask the user when a source has several plausible matches.
 */
import { Candidate, Query, choose } from './match';
import { MergeOptions, MergeResult, mergeEntry, readFetched } from './merge';
import { Source, SourceContext } from './sources';

export interface Found {
  source: Source;
  candidate: Candidate;
  merge: MergeResult;
}

export interface LookupUi {
  /** A source is about to be searched. */
  progress(source: Source): void;
  /**
   * Several plausible matches, or (`revised`) published versions under a changed title: return the
   * right one, 'next' to try the next source, or undefined to stop.
   */
  pick(candidates: Candidate[], source: Source, revised: boolean): Promise<Candidate | 'next' | undefined>;
}

export interface LookupResult {
  found?: Found;
  /** Sources that failed, with the reason (network, rate limit, bot check, …). */
  errors: { source: Source; message: string }[];
  /** The user stopped (cancelled a pick). */
  stopped?: boolean;
}

export async function lookup(
  entryText: string,
  q: Query,
  sources: readonly Source[],
  ctx: SourceContext,
  options: MergeOptions,
  ui: LookupUi,
): Promise<LookupResult> {
  const errors: LookupResult['errors'] = [];
  for (const source of sources) {
    ctx.signal?.throwIfAborted();
    ui.progress(source);
    try {
      const choice = choose(q, await source.search(q, ctx));
      let candidate: Candidate | undefined;
      if ('pick' in choice) candidate = choice.pick;
      else if ('ambiguous' in choice) {
        const picked = await ui.pick(choice.ambiguous, source, !!choice.revised);
        if (picked === undefined) return { errors, stopped: true };
        if (picked !== 'next') candidate = picked;
      }
      if (!candidate) continue;
      const fetched = readFetched(await source.bibtex(candidate, ctx));
      source.adjust?.(fetched);
      return { found: { source, candidate, merge: mergeEntry(entryText, fetched, options) }, errors };
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      errors.push({ source, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { errors };
}

