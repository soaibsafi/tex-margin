import * as vscode from 'vscode';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { CommentStore, TexComment, openDocument } from './store';
import { CommentsTree } from './tree';
import { Decorations } from './decorations';
import { History } from './history';
import { NoteComment, Threads } from './threads';
import { firstLine } from './render';
import { registerBibtexTidy } from './bibtidyCommands';
import { Previews } from './bibPreview';
import { BibUpdateApi, registerBibUpdate } from './bibUpdateCommands';
import { registerCitations } from './citesCommands';
import { registerReviews } from './reviewsCommands';

let store: CommentStore | undefined;

type Hit = { uri: vscode.Uri; comment: TexComment };

/** Returned from `activate`, used by the integration tests. */
export interface TexMarginApi {
  store: CommentStore;
  threads: Threads;
  storageUri: vscode.Uri | undefined;
  bibUpdate: BibUpdateApi;
}

export async function activate(context: vscode.ExtensionContext): Promise<TexMarginApi> {
  const s = (store = new CommentStore(new History(context.storageUri)));
  // BibTeX tools share one preview diff; comments in a .bib file follow entries a rewrite moves.
  const previews = new Previews((uri, apply) => s.rewrite(uri, apply));
  context.subscriptions.push(previews);
  registerBibtexTidy(context, previews);
  const bibUpdate = registerBibUpdate(context, previews);
  registerCitations(context, previews, bibUpdate);
  registerReviews(context, s, previews);
  const tree = new CommentsTree(s);
  const threads = new Threads(s, isCommentable);
  const decorations = new Decorations(s);
  const view = vscode.window.createTreeView('texMargin.comments', { treeDataProvider: tree, showCollapseAll: true });

  tree.showResolved = context.workspaceState.get('texMargin.showResolved', false);
  void vscode.commands.executeCommand('setContext', 'texMargin.showResolved', tree.showResolved);

  const updateBadge = () => {
    const open = s.files().reduce((n, f) => n + f.comments.filter((c) => !c.resolved).length, 0);
    view.badge = open ? { value: open, tooltip: `${open} open comment${open === 1 ? '' : 's'}` } : undefined;
  };

  context.subscriptions.push(
    s,
    tree,
    view,
    threads,
    decorations,
    s.onDidChange((uri) => {
      tree.refreshSoon();
      threads.renderSoon(uri);
      updateBadge();
      for (const editor of vscode.window.visibleTextEditors) {
        if (!uri || editor.document.uri.toString() === uri.toString()) decorations.refresh(editor);
      }
    }),
  );

  await s.load(); // also starts syncing every commented file against its current text

  // ---------------------------------------------------------------- keeping anchors in sync
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onDiskChange = (uri: vscode.Uri) => {
    if (uri.path.endsWith('/.texmargin/comments.json')) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder) void s.loadFolder(folder); // e.g. a git pull brought comments from your other machine
    } else if (s.has(uri) && !openDocument(uri)) {
      void s.sync(uri); // layer 3 for files changed on disk while closed (git pull, checkout, other editors)
    }
  };

  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onDiskChange),
    watcher.onDidCreate(onDiskChange),
    vscode.workspace.onDidChangeTextDocument((e) => isFileDoc(e.document) && s.onDocumentChanged(e)),
    vscode.workspace.onDidOpenTextDocument((doc) => isFileDoc(doc) && s.has(doc.uri) && void s.sync(doc.uri)),
    // After closing, the file on disk is the truth again (e.g. unsaved changes were discarded).
    vscode.workspace.onDidCloseTextDocument((doc) => isFileDoc(doc) && s.has(doc.uri) && void s.sync(doc.uri)),
    vscode.workspace.onDidSaveTextDocument(() => void s.flush()),
    vscode.workspace.onDidRenameFiles((e) => s.onFilesRenamed(e)),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await s.flush();
      await s.load();
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => decorations.refresh(e))),

    // Like Overleaf: moving the cursor into commented text selects that thread in the sidebar.
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!view.visible || !isFileDoc(e.textEditor.document)) return;
      const doc = e.textEditor.document;
      const c = s.commentAt(doc.uri, doc.offsetAt(e.selections[0].active));
      if (c && tree.isVisible(c) && !view.selection.some((n) => n.kind === 'comment' && n.id === c.id)) {
        void view.reveal(tree.commentNode(doc.uri, c.id), { select: true, focus: false, expand: true });
      }
    }),
  );

  // ---------------------------------------------------------------- helpers using local state

  /** Commands get a tree node, `{ id }` from a hover link, an inline thread or message, or nothing. */
  function target(t: unknown): Hit | undefined {
    if (t instanceof NoteComment) return s.find(t.threadId);
    if (t && typeof t === 'object') {
      const threadId = threads.idOf(t as vscode.CommentThread);
      if (threadId) return s.find(threadId);
      const id = (t as { id?: unknown }).id;
      if (typeof id === 'string') return s.find(id);
    }
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const c = s.commentAt(editor.document.uri, editor.document.offsetAt(editor.selection.active));
      if (c) return { uri: editor.document.uri, comment: c };
    }
    void vscode.window.showInformationMessage('Put the cursor inside a commented range, or use the TeX Margin sidebar.');
    return undefined;
  }

  async function reveal(hit: Hit, expand = false): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(hit.uri);
    await s.sync(hit.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (hit.comment.orphaned) {
      void vscode.window.showWarningMessage(
        `This comment lost its place (the text “${firstLine(hit.comment.quote, 40)}” is gone). ` +
          'Select the text it belongs to and use “Re-attach Comment to Selection”.',
      );
      return;
    }
    const range = s.rangeOf(hit.uri, hit.comment);
    if (!range) return;
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (expand) {
      threads.render(hit.uri);
      threads.expand(hit.comment.id);
    }
  }

  function setShowResolved(value: boolean): void {
    tree.showResolved = value;
    void context.workspaceState.update('texMargin.showResolved', value);
    void vscode.commands.executeCommand('setContext', 'texMargin.showResolved', value);
    tree.refreshNow();
  }

  // ---------------------------------------------------------------- commands
  const command = (id: string, fn: (...args: any[]) => unknown) => // eslint-disable-line @typescript-eslint/no-explicit-any
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // VS Code switches editor commenting off in Zen Mode (and when `comments.visible` is false); no
  // comment UI is drawn then. package.json routes the keybinding, context menu and palette entry to
  // this variant while the `commentingEnabled` context key is false.
  command('texMargin.addCommentEnablingCommenting', () => addComment(true));
  command('texMargin.addComment', () => addComment(false));

  async function addComment(commentingDisabled: boolean): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage('Select the text you want to comment on first.');
      return;
    }
    if (isCommentable(editor.document)) {
      if (commentingDisabled) {
        await vscode.commands.executeCommand('workbench.action.toggleCommenting');
        // VS Code recomputes commenting ranges asynchronously after this, so its own
        // "add comment" command could still fail; open the comment box ourselves instead.
        threads.draft(editor.document.uri, new vscode.Range(editor.selection.start, editor.selection.end));
        return;
      }
      // Opens VS Code's inline (multi-line, Markdown) comment box on the selection; the box's
      // "Add Comment" button then runs texMargin.thread.create.
      await vscode.commands.executeCommand('workbench.action.addComment');
      return;
    }
    const doc = editor.document;
    if (!isFileDoc(doc) || !vscode.workspace.getWorkspaceFolder(doc.uri)) {
      void vscode.window.showWarningMessage('TeX Margin can only comment on saved files inside an open workspace folder.');
      return;
    }
    // Language not in texMargin.languages: fall back to a simple input box.
    const range = new vscode.Range(editor.selection.start, editor.selection.end);
    const body = await vscode.window.showInputBox({ title: 'Add Comment', prompt: `On “${firstLine(doc.getText(range), 50)}”`, ignoreFocusOut: true });
    if (body?.trim()) await s.add(doc, range, body.trim(), author());
  }

  command('texMargin.thread.create', async (reply: vscode.CommentReply) => {
    const thread = reply.thread;
    const text = reply.text.trim();
    if (!text) return;
    const doc = await vscode.workspace.openTextDocument(thread.uri);
    let range = doc.validateRange(thread.range ?? new vscode.Range(0, 0, 0, 0));
    if (range.isEmpty || !doc.getText(range).trim()) {
      // From the gutter "+": comment on the whole line(s), without the indentation.
      const first = doc.lineAt(range.start.line);
      range = new vscode.Range(first.lineNumber, first.firstNonWhitespaceCharacterIndex, range.end.line, doc.lineAt(range.end.line).text.length);
    }
    threads.disposeDraft(thread); // the draft; the store renders the real thread
    const c = await s.add(doc, range, text, author());
    threads.render(doc.uri);
    threads.expand(c.id);
    if (view.visible) void view.reveal(tree.commentNode(doc.uri, c.id), { select: true, focus: false, expand: true });
  });

  command('texMargin.thread.reply', (reply: vscode.CommentReply) => {
    const id = threads.idOf(reply.thread);
    if (id && reply.text.trim()) s.reply(id, reply.text.trim(), author());
  });

  command('texMargin.reveal', async (t: unknown) => {
    const hit = target(t);
    if (hit) await reveal(hit);
  });

  command('texMargin.reply', async (t: unknown) => {
    const hit = target(t);
    if (hit) await reveal(hit, true); // the thread's reply box is right there
  });

  command('texMargin.edit', async (t: unknown) => {
    const hit = target(t);
    if (!hit) return;
    await reveal(hit, true);
    threads.startEditing(hit.comment.id, hit.comment.id);
  });

  command('texMargin.comment.edit', (m: NoteComment) => threads.startEditing(m.threadId, m.id));
  command('texMargin.comment.cancel', (m: NoteComment) => threads.stopEditing(m.threadId, m.id));
  command('texMargin.comment.save', (m: NoteComment) => {
    const body = (typeof m.body === 'string' ? m.body : m.body.value).trim();
    if (body) s.editMessage(m.threadId, m.id, body);
    threads.stopEditing(m.threadId, m.id);
  });
  command('texMargin.comment.delete', async (m: NoteComment) => {
    const ok = await vscode.window.showWarningMessage('Delete this reply?', { modal: true }, 'Delete');
    if (ok === 'Delete') s.removeReply(m.threadId, m.id);
  });

  command('texMargin.resolve', (t: unknown) => {
    const hit = target(t);
    if (hit) s.update(hit.comment.id, (c) => (c.resolved = true));
  });
  command('texMargin.reopen', (t: unknown) => {
    const hit = target(t);
    if (hit) s.update(hit.comment.id, (c) => (c.resolved = false));
  });

  command('texMargin.delete', async (t: unknown) => {
    const hit = target(t);
    if (!hit) return;
    const ok = await vscode.window.showWarningMessage(
      `Delete the comment “${firstLine(hit.comment.body, 50)}”${hit.comment.replies.length ? ' and its replies' : ''}?`,
      { modal: true },
      'Delete',
    );
    if (ok === 'Delete') s.remove(hit.comment.id);
  });

  command('texMargin.reattach', async (t: unknown) => {
    const hit = target(t);
    if (!hit) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty || editor.document.uri.toString() !== hit.uri.toString()) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(hit.uri));
      void vscode.window.showInformationMessage(
        `Select the text in ${vscode.workspace.asRelativePath(hit.uri)} that this comment belongs to, then run “Re-attach” again.`,
      );
      return;
    }
    s.reattach(hit.comment.id, editor.document, new vscode.Range(editor.selection.start, editor.selection.end));
  });

  command('texMargin.showResolved', () => setShowResolved(true));
  command('texMargin.hideResolved', () => setShowResolved(false));

  return { store: s, threads, storageUri: context.storageUri, bibUpdate };
}

export async function deactivate(): Promise<void> {
  await store?.flush();
}

// ------------------------------------------------------------------ helpers

function isFileDoc(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file';
}

function isCommentable(doc: vscode.TextDocument): boolean {
  const languages = vscode.workspace.getConfiguration('texMargin').get<string[]>('languages') ?? [];
  return isFileDoc(doc) && !!vscode.workspace.getWorkspaceFolder(doc.uri) && languages.includes(doc.languageId);
}

let cachedAuthor: string | undefined;
function author(): string {
  const configured = vscode.workspace.getConfiguration('texMargin').get<string>('author')?.trim();
  if (configured) return configured;
  if (cachedAuthor === undefined) {
    try {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      cachedAuthor = execFileSync('git', ['config', 'user.name'], { cwd, timeout: 2000, encoding: 'utf8' }).trim();
    } catch {
      cachedAuthor = '';
    }
    if (!cachedAuthor) cachedAuthor = os.userInfo().username;
  }
  return cachedAuthor;
}
