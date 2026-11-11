import { arxiv } from './arxiv';
import { crossref } from './crossref';
import { dblp } from './dblp';
import { openalex } from './openalex';
import { Source } from './source';

export const SOURCES: readonly Source[] = [arxiv, dblp, crossref, openalex];

export type { Source, SourceContext, SourceSecret } from './source';
