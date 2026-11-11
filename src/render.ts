import * as vscode from 'vscode';
import { TexComment } from './store';

const ACTION_COMMANDS = ['texMargin.reply', 'texMargin.resolve', 'texMargin.reopen', 'texMargin.edit', 'texMargin.delete'];

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function header(md: vscode.MarkdownString, author: string, iso: string): void {
  md.appendMarkdown('**');
  md.appendText(author);
  md.appendMarkdown(`** · ${when(iso)}`);
}

/** The whole thread as markdown, used for the editor hover and the sidebar tooltip. */
export function threadMarkdown(c: TexComment, withActions: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  header(md, c.author, c.createdAt);
  if (c.resolved) md.appendMarkdown(' · $(pass) resolved');
  if (c.orphaned) md.appendMarkdown(' · $(warning) detached');
  md.appendMarkdown('\n\n' + c.body + '\n\n');

  for (const r of c.replies) {
    md.appendMarkdown('---\n\n');
    header(md, r.author, r.createdAt);
    md.appendMarkdown('\n\n' + r.body + '\n\n');
  }

  if (withActions) {
    const args = encodeURIComponent(JSON.stringify([{ id: c.id }]));
    const link = (label: string, cmd: string) => `[${label}](command:${cmd}?${args})`;
    md.appendMarkdown(
      '---\n\n' +
        [
          link('$(reply) Reply', 'texMargin.reply'),
          c.resolved ? link('$(issue-reopened) Reopen', 'texMargin.reopen') : link('$(check) Resolve', 'texMargin.resolve'),
          link('$(edit) Edit', 'texMargin.edit'),
          link('$(trash) Delete', 'texMargin.delete'),
        ].join(' &nbsp;&nbsp; '),
    );
    md.isTrusted = { enabledCommands: ACTION_COMMANDS };
  }
  return md;
}

export function firstLine(text: string, max = 60): string {
  const line = text.split(/\r?\n/, 1)[0].trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
