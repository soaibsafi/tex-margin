import * as vscode from 'vscode';
import * as path from 'path';
import { CommentStore, TexComment } from './store';
import { firstLine, threadMarkdown } from './render';

export interface FileNode {
  kind: 'file';
  uri: vscode.Uri;
}
export interface CommentNode {
  kind: 'comment';
  uri: vscode.Uri;
  id: string;
}
export type Node = FileNode | CommentNode;

/** Sidebar: files with comments, and their comment threads in document order. */
export class CommentsTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  // Nodes are cached so `TreeView.reveal` always gets the same object for the same comment.
  private readonly fileNodes = new Map<string, FileNode>();
  private readonly commentNodes = new Map<string, CommentNode>();
  private timer: NodeJS.Timeout | undefined;

  showResolved = false;

  constructor(private readonly store: CommentStore) {}

  /** Debounced refresh, because typing moves anchors (and line numbers) on every keystroke. */
  refreshSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(undefined), 150);
  }

  refreshNow(): void {
    clearTimeout(this.timer);
    this.emitter.fire(undefined);
  }

  isVisible(c: TexComment): boolean {
    return this.showResolved || !c.resolved;
  }

  fileNode(uri: vscode.Uri): FileNode {
    const key = uri.toString();
    let node = this.fileNodes.get(key);
    if (!node) this.fileNodes.set(key, (node = { kind: 'file', uri }));
    return node;
  }

  commentNode(uri: vscode.Uri, id: string): CommentNode {
    let node = this.commentNodes.get(id);
    if (!node || node.uri.toString() !== uri.toString()) {
      this.commentNodes.set(id, (node = { kind: 'comment', uri, id }));
    }
    return node;
  }

  getChildren(node?: Node): vscode.ProviderResult<Node[]> {
    if (!node) {
      return this.store
        .files()
        .filter((f) => f.comments.some((c) => this.isVisible(c)))
        .sort((a, b) => vscode.workspace.asRelativePath(a.uri).localeCompare(vscode.workspace.asRelativePath(b.uri)))
        .map((f) => this.fileNode(f.uri));
    }
    if (node.kind === 'file') return this.commentChildren(node.uri);
    return [];
  }

  private commentChildren(uri: vscode.Uri): Node[] {
    return this.store
      .commentsFor(uri)
      .filter((c) => this.isVisible(c))
      .sort((a, b) => Number(!!a.orphaned) - Number(!!b.orphaned) || a.start - b.start)
      .map((c) => this.commentNode(uri, c.id));
  }

  getParent(node: Node): Node | undefined {
    return node.kind === 'comment' ? this.fileNode(node.uri) : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'file') {
      const open = this.store.commentsFor(node.uri).filter((c) => !c.resolved).length;
      const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `file:${node.uri.toString()}`;
      const dir = path.posix.dirname(vscode.workspace.asRelativePath(node.uri));
      item.description = `${open} open${dir && dir !== '.' ? ` · ${dir}` : ''}`;
      item.contextValue = 'file';
      return item;
    }

    const c = this.store.find(node.id)?.comment;
    if (!c) return new vscode.TreeItem('(deleted)');

    const item = new vscode.TreeItem(firstLine(c.body), vscode.TreeItemCollapsibleState.None);
    item.id = c.id;
    item.tooltip = threadMarkdown(c, false);
    item.command = { command: 'texMargin.reveal', title: 'Go to Comment', arguments: [{ id: c.id }] };

    const range = c.orphaned ? undefined : this.store.rangeOf(node.uri, c);
    const line = range ? `L${range.start.line + 1}` : undefined;
    const quote = c.quote ? `“${firstLine(c.quote, 40)}”` : undefined;
    const replies = c.replies.length ? `${c.replies.length} ${c.replies.length === 1 ? 'reply' : 'replies'}` : undefined;

    if (c.orphaned) {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      item.description = `detached · ${quote ?? ''}`;
      item.contextValue = 'comment.orphaned';
    } else if (c.resolved) {
      item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
      item.description = [line, quote].filter(Boolean).join(' · ');
      item.contextValue = 'comment.resolved';
    } else {
      item.iconPath = new vscode.ThemeIcon(c.replies.length ? 'comment-discussion' : 'comment');
      item.description = [line, quote, replies].filter(Boolean).join(' · ');
      item.contextValue = 'comment.open';
    }
    return item;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.emitter.dispose();
  }
}
