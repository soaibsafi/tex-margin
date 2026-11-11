export const MARKER = '<!-- tex-margin:reviews -->';

export interface ReviewItem {
  /** e.g. `R1.2`. */
  label: string;
  done: boolean;
  /** The reviewer's text (the `>` quote). */
  comment: string;
  /** Our response (LaTeX), everything after the quote. */
  response: string;
  /** Id of the margin comment that places it in the paper. */
  commentId?: string;
  /** 0-based line of its `###` heading. */
  line: number;
}

export interface Reviewer {
  name: string;
  items: ReviewItem[];
  line: number;
}

export interface ReviewsFile {
  title: string;
  /** Path (relative to the workspace folder) → git blob hash of the submitted version. */
  baseline: Map<string, string>;
  reviewers: Reviewer[];
}

export function isReviewsFile(text: string): boolean {
  return text.trimStart().startsWith(MARKER);
}

const HEADING = /^###\s+\[([ xX])\]\s+(\S+)(.*)$/;
const LINK = /<!--\s*comment:(\S+?)\s*-->/;

export function parseReviews(text: string): ReviewsFile {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const file: ReviewsFile = { title: '', baseline: new Map(), reviewers: [] };
  let reviewer: Reviewer | undefined;
  let item: (ReviewItem & { quote: string[]; rest: string[] }) | undefined;
  const finish = () => {
    if (!item) return;
    item.comment = item.quote.join('\n').trim();
    item.response = item.rest.join('\n').trim();
    const { quote: _q, rest: _r, ...plain } = item;
    reviewer!.items.push(plain);
    item = undefined;
  };
  lines.forEach((line, i) => {
    const baseline = /^<!--\s*baseline\s+(.*?)\s*-->$/.exec(line.trim());
    if (baseline && !reviewer) {
      for (const pair of baseline[1].split(/\s+/)) {
        const eq = pair.lastIndexOf('=');
        if (eq > 0) file.baseline.set(decodeURIComponent(pair.slice(0, eq)), pair.slice(eq + 1));
      }
      return;
    }
    const h = HEADING.exec(line);
    if (h && reviewer) {
      finish();
      item = { label: h[2], done: h[1] !== ' ', comment: '', response: '', commentId: LINK.exec(h[3])?.[1], line: i, quote: [], rest: [] };
      return;
    }
    const r = /^##\s+(.+?)\s*$/.exec(line);
    if (r && !line.startsWith('###')) {
      finish();
      reviewer = { name: r[1], items: [], line: i };
      file.reviewers.push(reviewer);
      return;
    }
    const t = /^#\s+(.+?)\s*$/.exec(line);
    if (t && !reviewer) {
      file.title = t[1].replace(/^Reviews:\s*/i, '');
      return;
    }
    if (!item) return;
    // The quote: `>` lines up to the first line that is not one; the rest is the response.
    if (!item.rest.some((l) => l.trim()) && /^\s*>/.test(line)) item.quote.push(line.replace(/^\s*>\s?/, ''));
    else item.rest.push(line);
  });
  finish();
  return file;
}

export function serializeReviews(title: string, baseline: Map<string, string>, reviewers: { name: string; items: { label: string; comment: string }[] }[]): string {
  const out = [MARKER];
  if (baseline.size) out.push(`<!-- baseline ${[...baseline].map(([p, h]) => `${encodeURIComponent(p).replace(/%2F/g, '/')}=${h}`).join(' ')} -->`);
  out.push(
    `# Reviews: ${title}`,
    '',
    '<!-- Check the split below and fix it if needed. Write each response under its quote, in LaTeX. Check the box',
    '     when a comment is addressed. "Generate Response Letter" in the TeX Margin sidebar turns this into a letter. -->',
  );
  for (const r of reviewers) {
    out.push('', `## ${r.name}`);
    for (const item of r.items) {
      out.push('', `### [ ] ${item.label}`);
      for (const l of item.comment.split('\n')) out.push(l.trim() ? `> ${l}` : '>');
      out.push('', '');
    }
  }
  return out.join('\n').replace(/\n{4,}/g, '\n\n\n') + '\n';
}

/** The heading line of `item` with the box checked or not. */
export function headingWithStatus(line: string, done: boolean): string {
  return line.replace(/^(###\s+\[)[ xX](\])/, `$1${done ? 'x' : ' '}$2`);
}

/** The heading line of `item` linked to a margin comment. */
export function headingWithLink(line: string, commentId: string | undefined): string {
  const bare = line.replace(/\s*<!--\s*comment:\S+?\s*-->/, '');
  return commentId ? `${bare} <!-- comment:${commentId} -->` : bare;
}

// ------------------------------------------------------------------ splitting pasted reviews

/**
 * Split reviews pasted from an email or a submission system (EasyChair, OpenReview, journal
 * systems) into reviewers and comments. A first guess: the user fixes it in the Markdown file.
 */
export function splitReviews(text: string): { name: string; items: { label: string; comment: string }[] }[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sections: { name: string; lines: string[] }[] = [];
  let numbered = 0;
  for (const line of lines) {
    // EasyChair's header in every review ("SUBMISSION: 17", "TITLE: …"): not a comment to answer.
    if (/^(SUBMISSION|TITLE|AUTHORS):/.test(line.trim())) continue;
    const name = reviewerHeader(line);
    if (name) {
      sections.push({ name: name === '#' ? `Reviewer ${++numbered}` : name, lines: [] });
      continue;
    }
    if (!sections.length) {
      if (!line.trim()) continue;
      sections.push({ name: 'Reviewer 1', lines: [] });
      numbered = 1;
    }
    sections[sections.length - 1].lines.push(line);
  }
  // The same reviewer named twice (e.g. "Reviewer 2" header and "Reviewer 2's comments"): merge.
  const merged: typeof sections = [];
  for (const s of sections) {
    const same = merged.find((m) => m.name === s.name);
    if (same) same.lines.push('', ...s.lines);
    else merged.push(s);
  }
  return merged
    .map((s, i) => ({ name: s.name, items: splitComments(s.lines.join('\n')).map((comment, k) => ({ label: `R${i + 1}.${k + 1}`, comment })) }))
    .filter((r) => r.items.length);
}

/** "Reviewer 2", "Reviewer #2:", "----- REVIEW 2 -----", "Referee B", "Meta-review", "Associate Editor". */
function reviewerHeader(line: string): string | undefined {
  const t = line.trim().replace(/^[-=*#_\s]+|[-=*#_\s:]+$/g, '');
  if (!t || t.length > 60) return undefined;
  const numbered = /^(?:official\s+review\s+.*?\bby\s+)?(review(?:er)?|referee)\s*[#:]?\s*([A-Za-z0-9]{1,6})(?:['’]s\s+(?:comments|report|review))?$/i.exec(t);
  if (numbered) {
    const id = numbered[2];
    return /^\d+$/.test(id) ? `Reviewer ${Number(id)}` : `Reviewer ${id.toUpperCase().length <= 2 ? id.toUpperCase() : id}`;
  }
  if (/^(meta[- ]?review(?:er)?|associate\s+editor|area\s+chair|editor)(?:['’]s\s+(?:comments|report))?$/i.test(t)) {
    return /editor/i.test(t) ? 'Editor' : 'Meta-review';
  }
  return undefined;
}

const NUMBERED = /^\s*(?:\(?\d{1,2}[.)]|\d{1,2}\s*[-:]|[A-Z]?\d{1,2}:|(?:comment|point|question|issue|weakness|concern)\s*\d{1,2}[.:)]?)\s+/i;
const BULLET = /^\s*[-*•]\s+/;

/** Numbered points if there are any, else bullets, else paragraphs. */
export function splitComments(text: string): string[] {
  const lines = text.split('\n');
  for (const marker of [NUMBERED, BULLET]) {
    const starts = lines.map((l, i) => (marker.test(l) ? i : -1)).filter((i) => i >= 0);
    if (starts.length < 2) continue;
    const parts: string[] = [];
    const intro = clean(lines.slice(0, starts[0]).join('\n'));
    if (intro) parts.push(intro);
    starts.forEach((s, k) => parts.push(clean(lines.slice(s, starts[k + 1] ?? lines.length).join('\n'))));
    return parts.filter(Boolean);
  }
  return text
    .split(/\n\s*\n/)
    .map(clean)
    .filter(Boolean);
}

function clean(s: string): string {
  return s
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
