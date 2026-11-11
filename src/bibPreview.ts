/**
 * Show a proposed new version of a file as a diff before anything changes. From the preview:
 *   A. apply all changes at once, or discard them;
 *   B. review them one by one: the proposal goes into the file (unsaved) and is diffed against the
 *      original, so the diff editor's own "revert" arrows undo single changes; then keep (saves) or
 *      discard (restores the original).
 * Used by Tidy BibTeX and Update Entry Metadata.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { lineEdits } from './bibtidy';

const SCHEME = 'texmargin-preview';
/** Context key: 'preview' or 'review' while such a diff is the active tab, '' otherwise. */
const CONTEXT = 'texMargin.preview';

/** Runs a whole-file rewrite; the comment store passes one that keeps anchors on moved text. */
export type Rewrite = (uri: vscode.Uri, apply: () => Thenable<boolean>) => Thenable<boolean>;

export interface PreviewRequest {
  uri: vscode.Uri;
  original: string;
  proposed: string;
  /** Diff editor title. */
  title: string;
  /** Shown with the preview. */
  message: string;
  /** An extra button on that message. */
  button?: { label: string; run: () => unknown };
  /** Offered when the file changed between preview and apply. */
  rerun?: () => unknown;
  /** Line (in the proposed text) to show first. */
  line?: number;
}

interface Session extends PreviewRequest {
  id: string;
  mode: 'preview' | 'review';
  /** Unsaved changes before we touched the file: then we never save it on the user's behalf. */
  wasDirty: boolean;
  /** Its diff tab has been opened (sessions without open tabs are dropped). */
  opened: boolean;
}

const nameOf = (uri: vscode.Uri) => path.posix.basename(uri.path);

export class Previews implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private nextId = 1;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly rewrite: Rewrite = (_uri, apply) => apply()) {
    const command = (id: string, fn: (arg?: unknown) => unknown) => vscode.commands.registerCommand(id, fn);
    this.disposables = [
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        provideTextDocumentContent: (uri) => {
          const q = new URLSearchParams(uri.query);
          const s = this.sessions.get(q.get('id') ?? '');
          if (!s) return '';
          return q.get('side') === 'proposed' ? s.proposed : s.original;
        },
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.collect()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.updateContext()),
      command('texMargin.preview.apply', (arg) => this.applyAll(arg)),
      command('texMargin.preview.review', (arg) => this.review(arg)),
      command('texMargin.preview.discard', (arg) => this.discardPreview(arg)),
      command('texMargin.preview.keep', (arg) => this.keep(arg)),
      command('texMargin.preview.discardReview', (arg) => this.discardReview(arg)),
    ];
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /** Open the preview diff. */
  async show(request: PreviewRequest): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(request.uri);
    const s: Session = { ...request, id: String(this.nextId++), mode: 'preview', wasDirty: doc.isDirty, opened: false };
    this.sessions.set(s.id, s);
    const selection = request.line !== undefined ? new vscode.Range(request.line, 0, request.line, 0) : undefined;
    await vscode.commands.executeCommand('vscode.diff', this.sideUri(s, 'original'), this.sideUri(s, 'proposed'), request.title, { preview: false, selection });
    s.opened = true;
    this.updateContext();
    const buttons = request.button ? [request.button.label] : [];
    void vscode.window
      .showInformationMessage(`${request.message} Use the editor title buttons: ✓ apply all, ⇄ review one by one, or discard.`, ...buttons)
      .then((pick) => pick && request.button?.run());
  }

  // ---------------------------------------------------------------- sessions

  private sideUri(s: Session, side: 'original' | 'proposed'): vscode.Uri {
    return s.uri.with({ scheme: SCHEME, query: `id=${s.id}&side=${side}`, fragment: '' });
  }

  private sessionOfTab(tab: vscode.Tab | undefined): Session | undefined {
    const input = tab?.input;
    if (input instanceof vscode.TabInputTextDiff && input.original.scheme === SCHEME) {
      return this.sessions.get(new URLSearchParams(input.original.query).get('id') ?? '');
    }
    return undefined;
  }

  private tabsOf(s: Session): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => this.sessionOfTab(t) === s);
  }

  /** Title-bar buttons pass the diff's (modified) resource; the palette passes nothing. */
  private sessionFor(arg: unknown, mode: Session['mode']): Session | undefined {
    let s: Session | undefined;
    if (arg instanceof vscode.Uri) {
      s =
        arg.scheme === SCHEME
          ? this.sessions.get(new URLSearchParams(arg.query).get('id') ?? '')
          : [...this.sessions.values()].find((x) => x.mode === 'review' && x.uri.toString() === arg.toString());
    }
    s ??= this.sessionOfTab(vscode.window.tabGroups.activeTabGroup.activeTab);
    return s?.mode === mode ? s : undefined;
  }

  private updateContext(): void {
    const s = this.sessionOfTab(vscode.window.tabGroups.activeTabGroup.activeTab);
    void vscode.commands.executeCommand('setContext', CONTEXT, s?.mode ?? '');
  }

  /** Drop sessions whose diff was closed (by us or by the user). */
  private collect(): void {
    const open = new Set(vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => this.sessionOfTab(t)));
    for (const [id, s] of this.sessions) if (s.opened && !open.has(s)) this.sessions.delete(id);
    this.updateContext();
  }

  private async close(s: Session): Promise<void> {
    await vscode.window.tabGroups.close(this.tabsOf(s));
    this.sessions.delete(s.id);
    this.updateContext();
  }

  /** The file, if it still holds exactly the text the preview was made from. */
  private async unchangedDocument(s: Session): Promise<vscode.TextDocument | undefined> {
    const doc = await vscode.workspace.openTextDocument(s.uri);
    if (doc.getText() === s.original) return doc;
    await this.close(s);
    const again = s.rerun ? ['Run Again'] : [];
    void vscode.window
      .showWarningMessage(`${nameOf(s.uri)} changed since this preview was made.`, ...again)
      .then((pick) => pick && s.rerun?.());
    return undefined;
  }

  private async setText(doc: vscode.TextDocument, text: string): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    for (const e of lineEdits(doc.getText(), text)) {
      edit.replace(doc.uri, new vscode.Range(e.start[0], e.start[1], e.end[0], e.end[1]), e.text);
    }
    const ok = await this.rewrite(doc.uri, () => vscode.workspace.applyEdit(edit));
    if (!ok) void vscode.window.showErrorMessage(`Could not edit ${nameOf(doc.uri)}.`);
    return ok;
  }

  // ---------------------------------------------------------------- A: apply all / discard

  private async applyAll(arg?: unknown): Promise<void> {
    const s = this.sessionFor(arg, 'preview');
    const doc = s && (await this.unchangedDocument(s));
    if (!s || !doc) return;
    const wasDirty = doc.isDirty;
    if (!(await this.setText(doc, s.proposed))) return;
    if (!wasDirty) await doc.save();
    await this.close(s);
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.window.showInformationMessage(`Changed ${nameOf(s.uri)}. Undo restores the original.`);
  }

  private async discardPreview(arg?: unknown): Promise<void> {
    const s = this.sessionFor(arg, 'preview');
    if (s) await this.close(s);
  }

  // ---------------------------------------------------------------- B: review one by one

  private async review(arg?: unknown): Promise<void> {
    const s = this.sessionFor(arg, 'preview');
    const doc = s && (await this.unchangedDocument(s));
    if (!s || !doc) return;
    s.wasDirty = doc.isDirty;
    if (!(await this.setText(doc, s.proposed))) return;
    const previewTabs = this.tabsOf(s);
    s.mode = 'review';
    // Open the review before closing the preview, so the session is never without a tab.
    const selection = s.line !== undefined ? new vscode.Range(s.line, 0, s.line, 0) : undefined;
    await vscode.commands.executeCommand('vscode.diff', this.sideUri(s, 'original'), s.uri, `${nameOf(s.uri)}: Original ↔ Proposed (unsaved)`, { preview: false, selection });
    await vscode.window.tabGroups.close(previewTabs);
    this.updateContext();
    void vscode.window.showInformationMessage(
      'Hover a change and click the arrow between the two sides to revert it. You can also edit the right side. Then keep or discard in the editor title.',
    );
  }

  private async keep(arg?: unknown): Promise<void> {
    const s = this.sessionFor(arg, 'review');
    if (!s) return;
    const doc = await vscode.workspace.openTextDocument(s.uri);
    if (!s.wasDirty) await doc.save();
    await this.close(s);
    await vscode.window.showTextDocument(doc, { preview: false });
    if (s.wasDirty) void vscode.window.showInformationMessage(`${nameOf(s.uri)} had unsaved changes before, so it was not saved.`);
  }

  private async discardReview(arg?: unknown): Promise<void> {
    const s = this.sessionFor(arg, 'review');
    if (!s) return;
    const doc = await vscode.workspace.openTextDocument(s.uri);
    if (!(await this.setText(doc, s.original))) return;
    if (!s.wasDirty) await doc.save();
    await this.close(s);
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}
