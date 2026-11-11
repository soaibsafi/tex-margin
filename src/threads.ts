import * as vscode from 'vscode';
import { CommentStore, TexComment } from './store';
import { firstLine } from './render';

/** One message (the comment itself or a reply) as shown in an inline thread. */
export class NoteComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  constructor(
    /** Message id: the comment id for the first message, the reply id for replies. */
    readonly id: string,
    /** Id of the TeX Margin comment (thread) this message belongs to. */
    readonly threadId: string,
    public body: string | vscode.MarkdownString,
    readonly author: vscode.CommentAuthorInformation,
    readonly contextValue: 'root' | 'reply',
    readonly timestamp: Date,
    readonly label?: string,
  ) {}
}

/**
 * Inline, multi-line comment threads in the editor (VS Code Comments API), kept in step with the
 * store. VS Code draws the gutter "+" and the thread widgets. The store stays the source of truth
 * for where each thread sits.
 */
export class Threads implements vscode.Disposable {
  readonly controller = vscode.comments.createCommentController('texMargin', 'TeX Margin');
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly ids = new WeakMap<vscode.CommentThread, string>();
  private readonly fingerprints = new Map<string, string>();
  /** Message ids currently being edited inline. */
  private readonly editing = new Set<string>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  /** The empty comment box opened by `draft`, if it has not been submitted yet. */
  private draftThread: vscode.CommentThread | undefined;

  constructor(private readonly store: CommentStore, isCommentable: (doc: vscode.TextDocument) => boolean) {
    this.controller.options = {
      prompt: 'Add a comment…',
      placeHolder: 'Write a comment (Markdown supported)',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => {
        if (!isCommentable(doc) || doc.lineCount === 0) return [];
        const last = doc.lineAt(doc.lineCount - 1);
        return [new vscode.Range(0, 0, last.lineNumber, last.text.length)];
      },
    };
  }

  /** Id of the TeX Margin comment shown by `thread`, if it is one of ours (not an empty draft). */
  idOf(thread: vscode.CommentThread): string | undefined {
    return this.ids.get(thread);
  }

  /** Re-render threads, debounced per file because anchors move with every keystroke. */
  renderSoon(uri: vscode.Uri | undefined): void {
    const key = uri?.toString() ?? '*';
    clearTimeout(this.pending.get(key));
    this.pending.set(key, setTimeout(() => {
      this.pending.delete(key);
      this.render(uri);
    }, 120));
  }

  render(uri?: vscode.Uri): void {
    const files = uri ? [{ uri, comments: this.store.commentsFor(uri) }] : this.store.files();
    const alive = new Set<string>();
    for (const f of files) {
      for (const c of f.comments) {
        const range = c.orphaned ? undefined : this.store.rangeOf(f.uri, c);
        if (!range) continue; // detached, or the file has not been read yet
        alive.add(c.id);
        this.upsert(f.uri, c, range);
      }
    }
    // Drop threads whose comment is gone, detached, or (on a per-file render) belongs to that file.
    for (const [id, thread] of this.threads) {
      if (alive.has(id)) continue;
      if (uri && thread.uri.toString() !== uri.toString() && this.store.find(id)) continue;
      thread.dispose();
      this.threads.delete(id);
      this.fingerprints.delete(id);
    }
  }

  private upsert(uri: vscode.Uri, c: TexComment, range: vscode.Range): void {
    let thread = this.threads.get(c.id);
    if (thread && thread.uri.toString() !== uri.toString()) {
      thread.dispose(); // file renamed
      thread = undefined;
    }
    if (!thread) {
      thread = this.controller.createCommentThread(uri, range, []);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      this.threads.set(c.id, thread);
      this.ids.set(thread, c.id);
    } else if (!thread.range || !thread.range.isEqual(range)) {
      thread.range = range;
    }

    const fp = JSON.stringify([c.body, c.replies, c.resolved, c.quote, [...this.editing].filter((m) => m === c.id || c.replies.some((r) => r.id === m))]);
    if (this.fingerprints.get(c.id) === fp) return;
    this.fingerprints.set(c.id, fp);

    thread.label = c.quote ? `“${firstLine(c.quote, 50)}”` : 'Comment';
    thread.contextValue = c.resolved ? 'resolved' : 'open';
    thread.state = c.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    thread.canReply = true;
    thread.comments = [
      this.message(c.id, c.id, c.body, c.author, 'root', c.createdAt, c.updatedAt),
      ...c.replies.map((r) => this.message(r.id, c.id, r.body, r.author, 'reply', r.createdAt, r.updatedAt)),
    ];
  }

  private message(
    id: string, threadId: string, body: string, author: string,
    kind: 'root' | 'reply', createdAt: string, updatedAt?: string,
  ): NoteComment {
    const editing = this.editing.has(id);
    const m = new NoteComment(
      id, threadId, editing ? body : new vscode.MarkdownString(body), { name: author }, kind,
      new Date(createdAt), updatedAt ? 'edited' : undefined,
    );
    if (editing) m.mode = vscode.CommentMode.Editing;
    return m;
  }

  /**
   * Open an empty inline comment box on `range`. Its "Add Comment" button runs texMargin.thread.create.
   * We create the draft ourselves instead of running `workbench.action.addComment`, because that
   * command looks up commenting ranges through the editor's gutter decorations, which fails in some
   * layouts (e.g. Zen Mode) with "The cursor must be within a commenting range to add a comment".
   */
  draft(uri: vscode.Uri, range: vscode.Range): vscode.CommentThread {
    this.draftThread?.dispose(); // only one unsent draft at a time
    const thread = this.controller.createCommentThread(uri, range, []);
    thread.canReply = true;
    thread.contextValue = 'draft';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.draftThread = thread;
    return thread;
  }

  /** Forget (and dispose) the draft once it was submitted. */
  disposeDraft(thread: vscode.CommentThread): void {
    if (this.draftThread === thread) this.draftThread = undefined;
    thread.dispose();
  }

  /** Number of threads currently shown (for tests). */
  count(): number {
    return this.threads.size;
  }

  expand(id: string): void {
    const thread = this.threads.get(id);
    if (thread) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  startEditing(threadId: string, messageId: string): void {
    this.editing.add(messageId);
    this.fingerprints.delete(threadId);
    this.expand(threadId);
    const hit = this.store.find(threadId);
    if (hit) this.render(hit.uri);
  }

  stopEditing(threadId: string, messageId: string): void {
    this.editing.delete(messageId);
    this.fingerprints.delete(threadId);
    const hit = this.store.find(threadId);
    if (hit) this.render(hit.uri);
  }

  dispose(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.controller.dispose(); // disposes all threads
  }
}
