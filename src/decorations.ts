import * as vscode from 'vscode';
import { CommentStore } from './store';
import { threadMarkdown } from './render';

/** Highlights commented text in editors, Overleaf-style, with the thread shown on hover. */
export class Decorations implements vscode.Disposable {
  private readonly highlight: vscode.TextEditorDecorationType;
  private readonly collapsed: vscode.TextEditorDecorationType;

  constructor(private readonly store: CommentStore) {
    const border = new vscode.ThemeColor('texMargin.commentBorder');
    this.highlight = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('texMargin.commentBackground'),
      borderStyle: 'solid',
      borderWidth: '0 0 1px 0',
      borderColor: border,
      overviewRulerColor: border,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    // A comment whose text was deleted completely: show a small marker where it used to be.
    this.collapsed = vscode.window.createTextEditorDecorationType({
      before: { contentText: '💬', margin: '0 2px 0 0' },
      overviewRulerColor: border,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) this.refresh(editor);
  }

  refresh(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const highlights: vscode.DecorationOptions[] = [];
    const collapsed: vscode.DecorationOptions[] = [];

    for (const c of this.store.commentsFor(doc.uri)) {
      if (c.resolved || c.orphaned) continue;
      const range = this.store.rangeOf(doc.uri, c);
      if (!range) continue;
      const hoverMessage = threadMarkdown(c, true);
      (range.isEmpty ? collapsed : highlights).push({ range, hoverMessage });
    }
    editor.setDecorations(this.highlight, highlights);
    editor.setDecorations(this.collapsed, collapsed);
  }

  dispose(): void {
    this.highlight.dispose();
    this.collapsed.dispose();
  }
}
