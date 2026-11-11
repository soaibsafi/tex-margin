/**
 * Responding to reviewers: import reviews into a Markdown file, attach comments to the paper (as
 * margin comments, so they stay put while you revise), track them in the "Reviews" view, and
 * generate the response letter. The formats and the letter are `reviews/`; this is VS Code plumbing.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Previews } from './bibPreview';
import { gitBlobHash } from './diff';
import { History } from './history';
import { changedExcerpt } from './reviews/changes';
import { ReviewItem, Reviewer, ReviewsFile, headingWithLink, headingWithStatus, isReviewsFile, parseReviews, serializeReviews, splitReviews } from './reviews/format';
import { LetterItemContext, generateLetter } from './reviews/letter';
import { CommentStore, openDocument } from './store';

const run = promisify(execFile);
const BASELINE_SCHEME = 'texmargin-baseline';
const EXCLUDE = /\/(node_modules|\.git|out|\.vscode-test)\//;

type Node =
  | { kind: 'file'; uri: vscode.Uri; reviews: ReviewsFile }
  | { kind: 'reviewer'; uri: vscode.Uri; reviewer: Reviewer }
  | { kind: 'item'; uri: vscode.Uri; reviewer: Reviewer; item: ReviewItem };

/** For the integration tests: skip the questions. */
export interface ImportOptions {
  name?: string;
  /** 'current' or a git ref. */
  baseline?: string;
}

export function registerReviews(context: vscode.ExtensionContext, store: CommentStore, previews: Previews): void {
  const baselines = new History(context.storageUri, 'baselines');
  const changed = new vscode.EventEmitter<Node | undefined>();
  let files: Map<string, ReviewsFile> | undefined;

  // ---------------------------------------------------------------- reading review files

  async function textOf(uri: vscode.Uri): Promise<string> {
    return openDocument(uri)?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  }

  /** `fresh`: read the files again (commands act on what is in them now, the view may lag a moment). */
  async function reviewFiles(fresh = false): Promise<Map<string, ReviewsFile>> {
    if (!files || fresh) {
      files = new Map();
      for (const uri of await vscode.workspace.findFiles('**/*.md')) {
        if (EXCLUDE.test(uri.path)) continue;
        try {
          const text = await textOf(uri);
          if (isReviewsFile(text)) files.set(uri.toString(), parseReviews(text));
        } catch {
          // unreadable: skip
        }
      }
    }
    return files;
  }

  let refreshTimer: NodeJS.Timeout | undefined;
  function refresh(): void {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      files = undefined;
      changed.fire(undefined);
    }, 300);
  }

  const done = (items: readonly ReviewItem[]) => `${items.filter((i) => i.done).length}/${items.length}`;

  const tree: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: changed.event,
    async getChildren(node) {
      if (!node) return [...(await reviewFiles())].map(([key, reviews]) => ({ kind: 'file', uri: vscode.Uri.parse(key), reviews }) as Node);
      if (node.kind === 'file') return node.reviews.reviewers.map((reviewer) => ({ kind: 'reviewer', uri: node.uri, reviewer }) as Node);
      if (node.kind === 'reviewer') return node.reviewer.items.map((item) => ({ kind: 'item', uri: node.uri, reviewer: node.reviewer, item }) as Node);
      return [];
    },
    getTreeItem(node) {
      if (node.kind === 'file') {
        const all = node.reviews.reviewers.flatMap((r) => r.items);
        const t = new vscode.TreeItem(node.reviews.title || path.posix.basename(node.uri.path), vscode.TreeItemCollapsibleState.Expanded);
        t.description = `${done(all)} addressed`;
        t.tooltip = vscode.workspace.asRelativePath(node.uri);
        t.iconPath = new vscode.ThemeIcon('checklist');
        t.contextValue = 'reviewFile';
        t.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
        return t;
      }
      if (node.kind === 'reviewer') {
        const t = new vscode.TreeItem(node.reviewer.name, vscode.TreeItemCollapsibleState.Expanded);
        t.description = done(node.reviewer.items);
        t.iconPath = new vscode.ThemeIcon('account');
        return t;
      }
      const { item } = node;
      const placed = !!item.commentId && !!store.find(item.commentId);
      const t = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
      t.description = firstLine(item.comment);
      t.iconPath = item.done ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed')) : new vscode.ThemeIcon('circle-large-outline');
      t.contextValue = `reviewItem.${item.done ? 'done' : 'open'}.${placed ? 'placed' : 'unplaced'}`;
      const tip = new vscode.MarkdownString();
      tip.appendMarkdown(`**${item.label}** (${node.reviewer.name})${placed ? ' · attached to the paper' : ''}\n\n`);
      tip.appendMarkdown(item.comment.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n');
      tip.appendMarkdown(item.response ? `**Response:** ${item.response}` : '_No response yet._');
      t.tooltip = tip;
      t.command = { command: 'texMargin.reviews.openItem', title: 'Open', arguments: [node] };
      return t;
    },
  };

  // ---------------------------------------------------------------- editing the Markdown file

  /** Replace one line of a reviews file (open or not), saving it if it had no unsaved changes. */
  async function setLine(uri: vscode.Uri, line: number, text: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const wasDirty = doc.isDirty;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, doc.lineAt(line).range, text);
    await vscode.workspace.applyEdit(edit);
    if (!wasDirty) await doc.save();
    refresh();
  }

  async function allItems(): Promise<Extract<Node, { kind: 'item' }>[]> {
    const out: Extract<Node, { kind: 'item' }>[] = [];
    for (const [key, reviews] of await reviewFiles(true)) {
      for (const reviewer of reviews.reviewers) for (const item of reviewer.items) out.push({ kind: 'item', uri: vscode.Uri.parse(key), reviewer, item });
    }
    return out;
  }

  /** From the view (a node), a test ({ uri, label }), or the palette (ask). */
  async function itemFrom(arg: unknown, placeholder: string, filter: (n: Extract<Node, { kind: 'item' }>) => boolean = () => true): Promise<Extract<Node, { kind: 'item' }> | undefined> {
    const items = await allItems();
    if (arg && typeof arg === 'object' && 'kind' in arg && (arg as Node).kind === 'item') {
      const n = arg as Extract<Node, { kind: 'item' }>;
      return items.find((i) => i.uri.toString() === n.uri.toString() && i.item.label === n.item.label);
    }
    if (arg && typeof arg === 'object' && 'label' in arg) {
      const { uri, label } = arg as { uri?: vscode.Uri; label: string };
      return items.find((i) => i.item.label === label && (!uri || i.uri.toString() === uri.toString()));
    }
    const candidates = items.filter(filter);
    if (!candidates.length) {
      void vscode.window.showInformationMessage('No matching review comments. Import reviews first (TeX Margin: Import Reviews).');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((n) => ({ label: `${n.item.done ? '$(pass-filled)' : '$(circle-large-outline)'} ${n.item.label}`, description: n.reviewer.name, detail: firstLine(n.item.comment, 120), n })),
      { placeHolder: placeholder, matchOnDetail: true },
    );
    return picked?.n;
  }

  // ---------------------------------------------------------------- import

  async function importReviews(textArg?: unknown, options: ImportOptions = {}): Promise<vscode.Uri | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage('Open the folder of your paper first.');
      return undefined;
    }
    let text = typeof textArg === 'string' ? textArg : await vscode.env.clipboard.readText();
    if (text.trim().length < 20) {
      const pick = await vscode.window.showInformationMessage(
        'Copy the reviews (from the email or the submission system) first, then run Import Reviews. Or start from an empty template and paste them in.',
        'Empty Template',
      );
      if (!pick) return undefined;
      text = 'Reviewer 1\n\n1. (paste the first comment here)\n2. (and the next one)';
    }

    const name = options.name ?? (await vscode.window.showInputBox({ title: 'Import Reviews', prompt: 'A name for this review round', value: 'Round 1', ignoreFocusOut: true }));
    if (!name?.trim()) return undefined;
    const baselineRef = options.baseline ?? (await pickBaseline(folder));
    if (!baselineRef) return undefined;
    let baseline: Map<string, string>;
    try {
      baseline = baselineRef === 'current' ? await currentBaseline() : await gitBaseline(folder, baselineRef);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not read the submitted version: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }

    const reviewers = splitReviews(text);
    let target = vscode.Uri.joinPath(folder.uri, 'reviews', `${slug(name)}.md`);
    for (let n = 2; await exists(target); n++) target = vscode.Uri.joinPath(folder.uri, 'reviews', `${slug(name)}-${n}.md`);
    await vscode.workspace.fs.writeFile(target, Buffer.from(serializeReviews(name.trim(), baseline, reviewers), 'utf8'));
    refresh();
    await vscode.window.showTextDocument(target, { preview: false });
    const count = reviewers.reduce((n, r) => n + r.items.length, 0);
    void vscode.window.showInformationMessage(
      `Split into ${count} comment${count === 1 ? '' : 's'} from ${reviewers.length} reviewer${reviewers.length === 1 ? '' : 's'}. Fix the split if needed, then write each response under its quote. ` +
        `To attach a comment to the paper, select the text in the .tex file and click 📌 in the Reviews view.`,
    );
    return target;
  }

  async function pickBaseline(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    type Item = vscode.QuickPickItem & { ref: string };
    const items: Item[] = [{ label: '$(file) Current files', description: 'as saved now', detail: 'Use this if you have not changed the paper since submitting it.', ref: 'current' }];
    try {
      const git = (...args: string[]) => run('git', args, { cwd: folder.uri.fsPath, timeout: 5000 }).then((r) => r.stdout.trim());
      const tags = (await git('tag', '--sort=-creatordate')).split('\n').filter(Boolean).slice(0, 10);
      const log = (await git('log', '-15', '--format=%h%x09%ad%x09%s', '--date=short')).split('\n').filter(Boolean);
      if (tags.length || log.length) items.push({ label: 'Git', kind: vscode.QuickPickItemKind.Separator, ref: '' });
      for (const tag of tags) items.push({ label: `$(tag) ${tag}`, ref: tag });
      for (const line of log) {
        const [hash, date, subject] = line.split('\t');
        items.push({ label: `$(git-commit) ${subject}`, description: `${hash} · ${date}`, ref: hash });
      }
    } catch {
      // not a git repository
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Which version did you submit?',
      placeHolder: 'The response letter quotes what changed since then',
      ignoreFocusOut: true,
    });
    return picked?.ref;
  }

  /** Hashes of the saved .tex files, with private snapshots so the texts can be recovered later. */
  async function currentBaseline(): Promise<Map<string, string>> {
    const baseline = new Map<string, string>();
    const texts = new Map<string, string>();
    for (const uri of await vscode.workspace.findFiles('**/*.tex')) {
      if (EXCLUDE.test(uri.path)) continue;
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      const hash = gitBlobHash(text);
      baseline.set(vscode.workspace.asRelativePath(uri, false), hash);
      texts.set(hash, text);
    }
    await baselines.keep(texts);
    return baseline;
  }

  /** Hashes of the .tex files in a commit; git keeps the texts. */
  async function gitBaseline(folder: vscode.WorkspaceFolder, ref: string): Promise<Map<string, string>> {
    const { stdout } = await run('git', ['ls-tree', '-r', ref, '--', '.'], { cwd: folder.uri.fsPath, timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
    const baseline = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
      if (m && /\.tex$/i.test(m[2])) baseline.set(m[2], m[1]);
    }
    if (!baseline.size) throw new Error(`no .tex files in ${ref}`);
    return baseline;
  }

  async function baselineText(reviews: ReviewsFile, uri: vscode.Uri): Promise<string | undefined> {
    const hash = reviews.baseline.get(vscode.workspace.asRelativePath(uri, false));
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return (await baselines.load(hash, folder?.uri.fsPath))?.text;
  }

  // ---------------------------------------------------------------- working on items

  async function openItem(arg?: unknown): Promise<void> {
    const n = await itemFrom(arg, 'Open which review comment?');
    if (!n) return;
    const editor = await vscode.window.showTextDocument(n.uri, { preview: false });
    const pos = new vscode.Position(Math.min(n.item.line + 1, editor.document.lineCount - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
  }

  async function place(arg?: unknown, target?: { uri: vscode.Uri; range: vscode.Range }): Promise<void> {
    let doc: vscode.TextDocument | undefined;
    let range: vscode.Range | undefined;
    if (target) {
      doc = await vscode.workspace.openTextDocument(target.uri);
      range = target.range;
    } else {
      const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find((e) => /\.tex$/i.test(e.document.uri.path));
      if (editor && /\.tex$/i.test(editor.document.uri.path) && !editor.selection.isEmpty) {
        doc = editor.document;
        range = new vscode.Range(editor.selection.start, editor.selection.end);
      }
    }
    if (!doc || !range) {
      void vscode.window.showInformationMessage('Select the text in the paper (.tex) that the review comment is about, then attach the comment.');
      return;
    }
    if (doc.uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(doc.uri)) {
      void vscode.window.showWarningMessage('Review comments can only be attached to saved files in the workspace.');
      return;
    }
    const n = await itemFrom(arg, `Attach which review comment to “${firstLine(doc.getText(range), 50)}”?`, (x) => !x.item.commentId || !store.find(x.item.commentId));
    if (!n) return;
    const existing = n.item.commentId ? store.find(n.item.commentId) : undefined;
    let id: string;
    if (existing) {
      store.reattach(existing.comment.id, doc, range);
      id = existing.comment.id;
    } else {
      const c = await store.add(doc, range, `${n.item.label}: ${n.item.comment}`, n.reviewer.name);
      if (n.item.done) store.update(c.id, (x) => (x.resolved = true));
      id = c.id;
    }
    const mdDoc = await vscode.workspace.openTextDocument(n.uri);
    await setLine(n.uri, n.item.line, headingWithLink(mdDoc.lineAt(n.item.line).text, id));
  }

  async function setDone(arg: unknown, value: boolean): Promise<void> {
    const n = await itemFrom(arg, value ? 'Mark which comment as addressed?' : 'Reopen which comment?', (x) => x.item.done !== value);
    if (!n) return;
    const mdDoc = await vscode.workspace.openTextDocument(n.uri);
    await setLine(n.uri, n.item.line, headingWithStatus(mdDoc.lineAt(n.item.line).text, value));
    if (n.item.commentId && store.find(n.item.commentId)) store.update(n.item.commentId, (c) => (c.resolved = value));
  }

  async function gotoPaper(arg?: unknown): Promise<void> {
    const n = await itemFrom(arg, 'Go to which review comment?', (x) => !!x.item.commentId && !!store.find(x.item.commentId));
    if (n?.item.commentId) await vscode.commands.executeCommand('texMargin.reveal', { id: n.item.commentId });
  }

  async function showChanges(arg?: unknown): Promise<void> {
    const n = await itemFrom(arg, 'Show the changes around which comment?', (x) => !!x.item.commentId && !!store.find(x.item.commentId));
    const hit = n?.item.commentId ? store.find(n.item.commentId) : undefined;
    if (!n || !hit) return;
    const reviews = (await reviewFiles(true)).get(n.uri.toString());
    const hash = reviews?.baseline.get(vscode.workspace.asRelativePath(hit.uri, false));
    if (!reviews || !hash || !(await baselineText(reviews, hit.uri))) {
      void vscode.window.showWarningMessage(`The submitted version of ${vscode.workspace.asRelativePath(hit.uri)} is not available (not in the baseline, no snapshot, not in git).`);
      return;
    }
    const left = vscode.Uri.from({ scheme: BASELINE_SCHEME, path: hit.uri.path, query: `hash=${hash}&folder=${encodeURIComponent(vscode.workspace.getWorkspaceFolder(hit.uri)?.uri.fsPath ?? '')}` });
    const range = store.rangeOf(hit.uri, hit.comment);
    await vscode.commands.executeCommand('vscode.diff', left, hit.uri, `${path.posix.basename(hit.uri.path)}: submitted ↔ now (${n.item.label})`, {
      preview: true,
      selection: range && new vscode.Range(range.start, range.start),
    });
  }

  // ---------------------------------------------------------------- the response letter

  async function letter(arg?: unknown, options: { confirm?: boolean } = {}): Promise<vscode.Uri | undefined> {
    const all = await reviewFiles(true);
    let uri: vscode.Uri | undefined;
    if (arg && typeof arg === 'object' && 'kind' in arg) uri = (arg as Node).uri;
    else if (arg instanceof vscode.Uri) uri = arg;
    else {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active && all.has(active.toString())) uri = active;
      else if (all.size === 1) uri = vscode.Uri.parse([...all.keys()][0]);
      else if (all.size > 1) uri = (await vscode.window.showQuickPick([...all.keys()].map((k) => ({ label: vscode.workspace.asRelativePath(vscode.Uri.parse(k)), uri: vscode.Uri.parse(k) })), { placeHolder: 'Generate the response letter for…' }))?.uri;
    }
    if (!uri) {
      if (!all.size) void vscode.window.showInformationMessage('No reviews yet. Run TeX Margin: Import Reviews first.');
      return undefined;
    }
    const reviews = parseReviews(await textOf(uri));
    const contexts = new Map<string, LetterItemContext>();
    for (const item of reviews.reviewers.flatMap((r) => r.items)) {
      const hit = item.commentId ? store.find(item.commentId) : undefined;
      if (!hit || hit.comment.orphaned) continue;
      const current = await textOf(hit.uri);
      const submitted = await baselineText(reviews, hit.uri);
      contexts.set(item.label, {
        file: vscode.workspace.asRelativePath(hit.uri, false),
        excerpt: submitted === undefined ? undefined : changedExcerpt(submitted, current, hit.comment.start, hit.comment.end),
      });
    }
    const text = generateLetter(reviews, contexts, vscode.workspace.asRelativePath(uri, false));
    const target = uri.with({ path: uri.path.replace(/(\.md)?$/i, '-response.tex') });
    const exists_ = await exists(target);
    if (exists_ && options.confirm !== false) {
      const original = await textOf(target);
      if (original === text) {
        void vscode.window.showInformationMessage(`${path.posix.basename(target.path)} is up to date.`);
        return target;
      }
      await previews.show({
        uri: target,
        original,
        proposed: text,
        title: `${path.posix.basename(target.path)} ↔ regenerated (preview)`,
        message: 'The response letter, regenerated from the reviews file.',
        rerun: () => letter(uri),
      });
      return target;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    await vscode.window.showTextDocument(target, { preview: false });
    const open = reviews.reviewers.flatMap((r) => r.items).filter((i) => !i.done).length;
    void vscode.window.showInformationMessage(`Wrote ${vscode.workspace.asRelativePath(target)}.${open ? ` ${open} comment${open === 1 ? ' is' : 's are'} still open (marked TODO).` : ''}`);
    return target;
  }

  // ---------------------------------------------------------------- wiring

  const view = vscode.window.createTreeView('texMargin.reviews', { treeDataProvider: tree, showCollapseAll: true });
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');
  const command = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn)); // eslint-disable-line @typescript-eslint/no-explicit-any

  context.subscriptions.push(
    view,
    changed,
    watcher,
    watcher.onDidChange(refresh),
    watcher.onDidCreate(refresh),
    watcher.onDidDelete(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => e.document.languageId === 'markdown' && e.contentChanges.length && refresh()),
    store.onDidChange(() => changed.fire(undefined)),
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
      provideTextDocumentContent: async (uri) => {
        const q = new URLSearchParams(uri.query);
        return (await baselines.load(q.get('hash') ?? undefined, q.get('folder') || undefined))?.text ?? '';
      },
    }),
    { dispose: () => clearTimeout(refreshTimer) },
  );
  command('texMargin.reviews.import', importReviews);
  command('texMargin.reviews.openItem', openItem);
  command('texMargin.reviews.place', place);
  command('texMargin.reviews.markDone', (arg) => setDone(arg, true));
  command('texMargin.reviews.markOpen', (arg) => setDone(arg, false));
  command('texMargin.reviews.gotoPaper', gotoPaper);
  command('texMargin.reviews.showChanges', showChanges);
  command('texMargin.reviews.letter', letter);
}

function firstLine(text: string, max = 60): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'reviews'
  );
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
