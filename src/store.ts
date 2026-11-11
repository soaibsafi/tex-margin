import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Change, applyChanges } from './anchor';
import { diffChanges, gitBlobHash, locate, refineChanges, remap } from './diff';
import { History } from './history';

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
}

export interface TexComment {
  id: string;
  /** UTF-16 offsets into the text whose git blob hash is stored with the file entry. */
  start: number;
  end: number;
  /** The commented text. A last-resort locator when no old version of the file can be found. */
  quote: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
  resolved: boolean;
  /** Could not be located after an outside change. Kept, never silently dropped. */
  orphaned?: boolean;
  replies: Reply[];
}

interface PersistedEntry {
  hash: string;
  comments: TexComment[];
}

interface StoreFile {
  version: 1 | 2;
  files: Record<string, PersistedEntry>;
}

interface Entry {
  comments: TexComment[];
  /** The text the offsets currently refer to. `undefined` until the file has been synced once. */
  text?: string;
  /** Hash from the store file, used while `text` is still unknown. */
  storedHash?: string;
  lineStarts?: number[];
  /** Serializes syncs of this file. */
  syncing: Promise<void>;
}

export const STORE_DIR = '.texmargin';
const STORE_FILE = 'comments.json';
const SAVE_DELAY_MS = 500;
const decoder = new TextDecoder('utf-8');

/**
 * Source of truth for all comments. It is persisted to `<folder>/.texmargin/comments.json`.
 *
 * Layer 1: edits in VS Code move the anchors live (`onDocumentChanged`).
 * Layer 2: each file stores the git blob hash of the text its offsets refer to. A matching hash
 *          means the offsets are exact.
 * Layer 3: on a mismatch, the old text is recovered (from memory, a snapshot, or git) and diffed
 *          against the new text, and the anchors are mapped through that diff. Only without any old
 *          text does it fall back to searching for the quote.
 */
export class CommentStore implements vscode.Disposable {
  private entries = new Map<string, Entry>();
  private storeExists = new Set<string>();
  private broken = new Set<string>();
  /** Last content written to or read from each store file, to skip no-op writes and our own echoes. */
  private lastContent = new Map<string, string>();
  /** Comments created since the last write. They survive a reload of the store file. */
  private unsaved = new Set<string>();
  private saveTimer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();
  /** How recent syncs resolved their anchors (`file: exact|memory|snapshot|git|quote`). For tests/debugging. */
  readonly syncLog: string[] = [];

  private readonly emitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  /** Fires with the affected file, or `undefined` for "everything". */
  readonly onDidChange = this.emitter.event;

  constructor(private readonly history: History) {}

  // ================================================================ loading / saving

  async load(): Promise<void> {
    this.entries.clear();
    this.storeExists.clear();
    this.broken.clear();
    this.lastContent.clear();
    await Promise.all((vscode.workspace.workspaceFolders ?? []).map((f) => this.loadFolder(f)));
    this.emitter.fire(undefined);
  }

  /** (Re)load one folder's store, e.g. after `git pull` changed `comments.json`. */
  async loadFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const folderKey = folder.uri.toString();
    let raw: string;
    try {
      raw = decoder.decode(await vscode.workspace.fs.readFile(this.storeUri(folder)));
    } catch {
      return; // no store (yet)
    }
    if (this.lastContent.get(folderKey) === raw) return; // our own write echoing back
    this.storeExists.add(folderKey);

    let data: StoreFile;
    try {
      data = JSON.parse(raw) as StoreFile;
    } catch (err) {
      this.broken.add(folderKey);
      void vscode.window.showErrorMessage(
        `TeX Margin: could not parse ${vscode.workspace.asRelativePath(this.storeUri(folder))} (${String(err)}). ` +
          'Comments in this folder are read-only until the file is fixed (a merge conflict?).',
      );
      return;
    }
    this.broken.delete(folderKey);
    this.lastContent.set(folderKey, raw);

    // Comments added here but not written yet would otherwise be lost by the reload.
    const keep = new Map<string, TexComment[]>();
    for (const [key, entry] of this.entries) {
      if (!this.inFolder(key, folder)) continue;
      const fresh = entry.comments.filter((c) => this.unsaved.has(c.id));
      if (fresh.length) keep.set(key, fresh);
      this.entries.delete(key);
    }

    for (const [rel, persisted] of Object.entries(data.files ?? {})) {
      const uri = vscode.Uri.joinPath(folder.uri, ...rel.split('/'));
      for (const c of persisted.comments) c.replies ??= [];
      this.entries.set(uri.toString(), {
        comments: persisted.comments,
        storedHash: persisted.hash,
        syncing: Promise.resolve(),
      });
    }
    for (const [key, fresh] of keep) {
      const entry = this.entryFor(key);
      for (const c of fresh) if (!entry.comments.some((x) => x.id === c.id)) entry.comments.push(c);
    }

    for (const key of this.entries.keys()) {
      if (this.inFolder(key, folder)) void this.sync(vscode.Uri.parse(key));
    }
    this.emitter.fire(undefined);
  }

  scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  /** Write snapshots and all stores now. Writes are serialized. */
  flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.writing = this.writing.then(() => this.writeAll()).catch((err) => {
      void vscode.window.showErrorMessage(`TeX Margin: failed to save comments: ${String(err)}`);
    });
    return this.writing;
  }

  private async writeAll(): Promise<void> {
    const unsavedNow = new Set(this.unsaved);
    const byFolder = new Map<string, { folder: vscode.WorkspaceFolder; files: Record<string, PersistedEntry> }>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) byFolder.set(folder.uri.toString(), { folder, files: {} });

    const snapshots = new Map<string, string>();
    for (const [key, entry] of [...this.entries].sort(([a], [b]) => a.localeCompare(b))) {
      if (entry.comments.length === 0) continue;
      const uri = vscode.Uri.parse(key);
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) continue;
      let hash = entry.storedHash ?? '';
      let comments = entry.comments;
      if (entry.text !== undefined) {
        // The store always describes the file as saved on disk, never an unsaved buffer. That way
        // whatever you commit (the .tex file plus comments.json) is consistent, and another
        // machine gets exact offsets after a pull.
        const saved = await this.savedTextFor(uri, entry.text);
        if (saved !== entry.text) comments = this.mappedCopy(entry.comments, entry.text, saved);
        hash = gitBlobHash(saved);
        snapshots.set(hash, saved);
      }
      // Keys come from `Uri.toString()`, which lowercases Windows drive letters; normalize the folder
      // the same way, or `C:` vs `c:` yields keys like "../../../c:/…/main.tex".
      const folderPath = vscode.Uri.parse(folder.uri.toString()).path;
      byFolder.get(folder.uri.toString())!.files[path.posix.relative(folderPath, uri.path)] = {
        hash,
        comments: [...comments].sort((a, b) => a.start - b.start),
      };
    }

    // Snapshots first: a store must never reference text we cannot recover.
    await this.history.sync(snapshots).catch(() => undefined);

    for (const [folderKey, { folder, files }] of byFolder) {
      if (this.broken.has(folderKey)) continue;
      if (Object.keys(files).length === 0 && !this.storeExists.has(folderKey)) continue;
      const content = JSON.stringify({ version: 2, files } satisfies StoreFile, null, 2) + '\n';
      if (this.lastContent.get(folderKey) === content) continue; // nothing changed, keep git quiet

      const dir = vscode.Uri.joinPath(folder.uri, STORE_DIR);
      const tmp = vscode.Uri.joinPath(dir, `${STORE_FILE}.tmp`);
      this.lastContent.set(folderKey, content); // set before writing, so the watcher sees our echo
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(tmp, Buffer.from(content, 'utf8'));
      await vscode.workspace.fs.rename(tmp, this.storeUri(folder), { overwrite: true });
      this.storeExists.add(folderKey);
    }
    for (const id of unsavedNow) this.unsaved.delete(id);
  }

  // ================================================================ keeping anchors in sync

  /**
   * Bring a file's anchors up to date with its current text: the open document if there is one,
   * otherwise the file on disk. Called on load, on open and close, and when the file changes on disk.
   */
  sync(uri: vscode.Uri): Promise<void> {
    const entry = this.entries.get(uri.toString());
    if (!entry) return Promise.resolve();
    entry.syncing = entry.syncing.then(() => this.doSync(uri, entry)).catch((err) => console.error('TeX Margin sync', err));
    return entry.syncing;
  }

  private async doSync(uri: vscode.Uri, entry: Entry): Promise<void> {
    let text = await this.readCurrent(uri);
    if (text === undefined) return; // file missing: keep comments as they are until it is back

    if (entry.text !== undefined) {
      // We know exactly which text the offsets refer to (e.g. the file changed on disk while closed).
      if (entry.text !== text) {
        this.log(uri, 'memory');
        this.mapThrough(entry, entry.text, text);
        this.changed(uri);
      }
      return;
    }

    if (entry.storedHash && gitBlobHash(text) === entry.storedHash) {
      this.log(uri, 'exact');
      this.setText(entry, text); // layer 2: offsets are exact
      this.emitter.fire(uri);
      return;
    }

    // Layer 3: recover the text the stored offsets were written against.
    const ids = new Set(entry.comments.map((c) => c.id));
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    // The store describes the saved file, so with unsaved changes open (e.g. restored by VS Code
    // after a restart) the file on disk is usually the exact old text.
    const disk = openDocument(uri) ? await this.readDisk(uri) : undefined;
    const old =
      disk !== undefined && gitBlobHash(disk) === entry.storedHash
        ? { text: disk, source: 'disk' }
        : await this.history.load(entry.storedHash, folder?.uri.fsPath);
    text = (await this.readCurrent(uri)) ?? text; // edits may have happened while we waited

    if (old !== undefined) {
      this.log(uri, old.source);
      this.mapThrough(entry, old.text, text, ids);
    } else {
      this.log(uri, 'quote');
      // No old version anywhere: last resort, search for the quotes.
      for (const c of entry.comments) {
        if (!ids.has(c.id)) continue;
        const found = locate(text, c.quote, c.start);
        if (found) Object.assign(c, found, { orphaned: false });
        else c.orphaned = true;
      }
      this.setText(entry, text);
    }
    this.changed(uri);
  }

  /** The text of `uri` as saved on disk, if its open document has unsaved changes; else `text`. */
  private async savedTextFor(uri: vscode.Uri, text: string): Promise<string> {
    if (!openDocument(uri)?.isDirty) return text;
    return (await this.readDisk(uri)) ?? text;
  }

  /** Copies of `comments` with offsets mapped from `fromText` to `toText`. */
  private mappedCopy(comments: readonly TexComment[], fromText: string, toText: string): TexComment[] {
    const changes = diffChanges(fromText, toText);
    return comments.map((c) => {
      if (c.orphaned) return c;
      const span = remap(toText, changes, c, c.quote);
      // A comment on text that exists only in the unsaved buffer is stored collapsed at its
      // place, with its quote, and becomes whole again once the text is saved.
      return { ...c, ...span, quote: span.end > span.start ? toText.slice(span.start, span.end) : c.quote };
    });
  }

  /** Map anchors through the diff of two texts (layer 3) and adopt `newText`. */
  private mapThrough(entry: Entry, oldText: string, newText: string, ids?: Set<string>): void {
    const changes = diffChanges(oldText, newText);
    for (const c of entry.comments) {
      if (ids && !ids.has(c.id)) continue;
      if (c.orphaned) {
        const found = locate(newText, c.quote, c.start);
        if (found) Object.assign(c, found, { orphaned: false });
        continue;
      }
      const span = remap(newText, changes, c, c.quote);
      c.start = span.start;
      c.end = span.end;
      if (span.end > span.start) c.quote = newText.slice(span.start, span.end);
    }
    this.setText(entry, newText);
  }

  /**
   * Run a programmatic rewrite of an open file (e.g. Tidy BibTeX) and map its anchors like an
   * external change (layer 3) instead of like typing: text the rewrite moved (sorted entries) is
   * found again, where layer 1 alone would leave the comment collapsed at the old place.
   */
  async rewrite(uri: vscode.Uri, apply: () => Thenable<boolean>): Promise<boolean> {
    const entry = this.entries.get(uri.toString());
    const before = entry?.text;
    const old = new Map(entry?.comments.map((c) => [c.id, { start: c.start, end: c.end, quote: c.quote, orphaned: c.orphaned }]));
    const ok = await apply();
    const after = entry?.text;
    if (!ok || !entry || before === undefined || after === undefined || before === after) return ok;
    const changes = diffChanges(before, after);
    for (const c of entry.comments) {
      const o = old.get(c.id);
      if (!o || o.orphaned) continue;
      const span = remap(after, changes, o, o.quote);
      c.start = span.start;
      c.end = span.end;
      if (span.end > span.start) c.quote = after.slice(span.start, span.end);
    }
    this.changed(uri);
    return ok;
  }

  /** Layer 1: move anchors through a live edit. */
  onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    const entry = this.entries.get(e.document.uri.toString());
    if (!entry || entry.text === undefined || e.contentChanges.length === 0) return; // not synced yet: the sync will catch up

    const newText = e.document.getText();
    const raw: Change[] = e.contentChanges.map((c) => ({ offset: c.rangeOffset, deleteLength: c.rangeLength, text: c.text }));
    const expected = raw.reduce((n, c) => n + c.text.length - c.deleteLength, entry.text.length);
    if (expected !== newText.length) {
      this.mapThrough(entry, entry.text, newText); // we lost track somehow: recover by diffing
      this.changed(e.document.uri);
      return;
    }

    const changes = refineChanges(entry.text, raw);
    for (const c of entry.comments) {
      if (c.orphaned) continue;
      const span = applyChanges(c, changes, c.quote);
      c.start = span.start;
      c.end = span.end;
      // A collapsed comment keeps its last quote, so it can still be found again later.
      if (span.end > span.start) c.quote = newText.slice(span.start, span.end);
    }
    this.setText(entry, newText);
    this.emitter.fire(e.document.uri);
    // Typing in an unsaved buffer does not change positions in the saved file, so there is
    // nothing to write until it is saved (or reverted, or reloaded from disk).
    if (!e.document.isDirty) this.scheduleSave();
  }

  onFilesRenamed(e: vscode.FileRenameEvent): void {
    let moved = false;
    for (const { oldUri, newUri } of e.files) {
      const oldKey = oldUri.toString();
      for (const [key, entry] of [...this.entries]) {
        if (key === oldKey || key.startsWith(oldKey + '/')) {
          this.entries.delete(key);
          this.entries.set(newUri.toString() + key.slice(oldKey.length), entry);
          moved = true;
        }
      }
    }
    if (moved) this.changed(undefined);
  }

  has(uri: vscode.Uri): boolean {
    return this.entries.has(uri.toString());
  }

  // ================================================================ CRUD

  async add(doc: vscode.TextDocument, range: vscode.Range, body: string, author: string): Promise<TexComment> {
    const entry = this.entryFor(doc.uri.toString());
    await entry.syncing;
    if (entry.text === undefined) this.setText(entry, doc.getText());
    const start = doc.offsetAt(range.start);
    const end = doc.offsetAt(range.end);
    const comment: TexComment = {
      id: randomUUID(),
      start,
      end,
      quote: doc.getText().slice(start, end),
      author,
      body,
      createdAt: new Date().toISOString(),
      resolved: false,
      replies: [],
    };
    entry.comments.push(comment);
    this.unsaved.add(comment.id);
    this.changed(doc.uri);
    return comment;
  }

  /** Add comments that are already located in `text` (the file's current text), e.g. on import. */
  async addLocated(uri: vscode.Uri, text: string, comments: TexComment[]): Promise<void> {
    const entry = this.entryFor(uri.toString());
    await entry.syncing;
    if (entry.text === undefined) this.setText(entry, text);
    else if (entry.text !== text) return; // changed under us; caller can retry
    for (const c of comments) {
      if (entry.comments.some((x) => x.id === c.id)) continue;
      entry.comments.push(c);
      this.unsaved.add(c.id);
    }
    this.changed(uri);
  }

  update(id: string, mutate: (c: TexComment) => void): void {
    const hit = this.find(id);
    if (!hit) return;
    mutate(hit.comment);
    this.changed(hit.uri);
  }

  reply(id: string, body: string, author: string): void {
    this.update(id, (c) => c.replies.push({ id: randomUUID(), author, body, createdAt: new Date().toISOString() }));
  }

  editMessage(id: string, messageId: string, body: string): void {
    this.update(id, (c) => {
      const now = new Date().toISOString();
      if (messageId === c.id) Object.assign(c, { body, updatedAt: now });
      else {
        const r = c.replies.find((x) => x.id === messageId);
        if (r) Object.assign(r, { body, updatedAt: now });
      }
    });
  }

  removeReply(id: string, replyId: string): void {
    this.update(id, (c) => (c.replies = c.replies.filter((r) => r.id !== replyId)));
  }

  reattach(id: string, doc: vscode.TextDocument, range: vscode.Range): void {
    const hit = this.find(id);
    if (!hit || hit.uri.toString() !== doc.uri.toString()) return;
    const entry = this.entries.get(doc.uri.toString())!;
    if (entry.text === undefined) this.setText(entry, doc.getText());
    this.update(id, (c) => {
      c.start = doc.offsetAt(range.start);
      c.end = doc.offsetAt(range.end);
      c.quote = doc.getText(range);
      c.orphaned = false;
    });
  }

  remove(id: string): void {
    const hit = this.find(id);
    if (!hit) return;
    const key = hit.uri.toString();
    const entry = this.entries.get(key)!;
    entry.comments = entry.comments.filter((c) => c.id !== id);
    if (entry.comments.length === 0) this.entries.delete(key);
    this.changed(hit.uri);
  }

  // ================================================================ queries

  find(id: string): { uri: vscode.Uri; comment: TexComment } | undefined {
    for (const [key, entry] of this.entries) {
      const comment = entry.comments.find((c) => c.id === id);
      if (comment) return { uri: vscode.Uri.parse(key), comment };
    }
    return undefined;
  }

  commentsFor(uri: vscode.Uri): readonly TexComment[] {
    return this.entries.get(uri.toString())?.comments ?? [];
  }

  files(): { uri: vscode.Uri; comments: readonly TexComment[] }[] {
    return [...this.entries].map(([key, e]) => ({ uri: vscode.Uri.parse(key), comments: e.comments }));
  }

  /** The innermost unresolved comment containing `offset`. */
  commentAt(uri: vscode.Uri, offset: number): TexComment | undefined {
    return this.commentsFor(uri)
      .filter((c) => !c.orphaned && !c.resolved && c.start <= offset && offset <= c.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  }

  /** Range of a comment, from the open document or from the synced text of a closed file. */
  rangeOf(uri: vscode.Uri, c: TexComment): vscode.Range | undefined {
    const doc = openDocument(uri);
    if (doc) return doc.validateRange(new vscode.Range(doc.positionAt(c.start), doc.positionAt(c.end)));
    const entry = this.entries.get(uri.toString());
    if (entry?.text === undefined) return undefined;
    return new vscode.Range(this.positionIn(entry, c.start), this.positionIn(entry, c.end));
  }

  private positionIn(entry: Entry, offset: number): vscode.Position {
    const text = entry.text!;
    if (!entry.lineStarts) {
      entry.lineStarts = [0];
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) entry.lineStarts.push(i + 1);
    }
    const starts = entry.lineStarts;
    offset = Math.max(0, Math.min(offset, text.length));
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    let ch = offset - starts[lo];
    if (ch > 0 && text.charCodeAt(offset - 1) === 13) ch--; // between \r and \n
    return new vscode.Position(lo, ch);
  }

  // ================================================================ internals

  private entryFor(key: string): Entry {
    let entry = this.entries.get(key);
    if (!entry) this.entries.set(key, (entry = { comments: [], syncing: Promise.resolve() }));
    return entry;
  }

  private setText(entry: Entry, text: string): void {
    entry.text = text;
    entry.lineStarts = undefined;
  }

  private async readCurrent(uri: vscode.Uri): Promise<string | undefined> {
    const doc = openDocument(uri);
    return doc ? doc.getText() : this.readDisk(uri);
  }

  private async readDisk(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return decoder.decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }

  private storeUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, STORE_DIR, STORE_FILE);
  }

  private inFolder(key: string, folder: vscode.WorkspaceFolder): boolean {
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(key))?.uri.toString() === folder.uri.toString();
  }

  private log(uri: vscode.Uri, how: string): void {
    this.syncLog.push(`${vscode.workspace.asRelativePath(uri, false)}: ${how}`);
    if (this.syncLog.length > 200) this.syncLog.shift();
  }

  private changed(uri: vscode.Uri | undefined): void {
    this.emitter.fire(uri);
    this.scheduleSave();
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
    this.emitter.dispose();
  }
}

export function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key && !d.isClosed);
}

