/**
 * "Update Entry Metadata…": look up the BibTeX entry at the cursor on DBLP, Crossref, OpenAlex (in
 * the configured order), merge what is found, and show it in the preview diff (bibPreview.ts).
 * The lookup itself is `bibupdate/`; this file is VS Code plumbing.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { Previews } from './bibPreview';
import { FetchFn, Http } from './bibupdate/http';
import { Candidate, queryOf } from './bibupdate/match';
import { FieldChange, MergeOptions } from './bibupdate/merge';
import { BibEntry, entryAt, parseEntries } from './bibupdate/parse';
import { SOURCES, Source, SourceContext } from './bibupdate/sources';
import { lookup } from './bibupdate/update';

const DEFAULT_SOURCES = ['arxiv', 'dblp', 'crossref', 'openalex'];
const DEFAULT_SKIP = ['timestamp', 'biburl', 'bibsource', 'editor', 'collection'];
const secretKey = (id: string) => `texMargin.bibUpdate.${id}`;

export interface BibUpdateApi {
  /** For the integration tests. */
  setFetch(fn: FetchFn): void;
  /** For other commands that use the sources (citation checks): same client, keys and settings. */
  sourceContext(signal: AbortSignal, uri: vscode.Uri): Promise<SourceContext>;
  sources(uri: vscode.Uri): Source[];
  mergeOptions(uri: vscode.Uri): MergeOptions;
  /** The candidate picker of Update Entry Metadata. */
  pick(key: string, candidates: Candidate[], source: Source, revised: boolean, yourTitle?: string): Promise<Candidate | 'next' | undefined>;
}

export function registerBibUpdate(context: vscode.ExtensionContext, previews: Previews): BibUpdateApi {
  const version = String(context.extension.packageJSON.version ?? '0');
  const appId = `texMargin_${version}`;
  const http = new Http(`tex-margin/${version} (VS Code extension)`);
  for (const s of SOURCES) for (const [host, ms] of Object.entries(s.pacing ?? {})) http.pace(host, ms);
  const nameOf = (uri: vscode.Uri) => path.posix.basename(uri.path);

  // Parsed entries per document version, for the code action (asked on every cursor move).
  const parsed = new Map<string, { version: number; entries: BibEntry[] }>();
  const entriesOf = (doc: vscode.TextDocument): BibEntry[] => {
    const hit = parsed.get(doc.uri.toString());
    if (hit?.version === doc.version) return hit.entries;
    const entries = parseEntries(doc.getText());
    parsed.set(doc.uri.toString(), { version: doc.version, entries });
    return entries;
  };

  async function secrets(): Promise<Record<string, string | undefined>> {
    const out: Record<string, string | undefined> = {};
    for (const s of SOURCES) for (const secret of s.secrets ?? []) out[secret.id] = (await context.secrets.get(secretKey(secret.id))) || undefined;
    return out;
  }

  async function updateEntry(uriArg?: unknown, offsetArg?: unknown): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const uri = uriArg instanceof vscode.Uri ? uriArg : editor?.document.uri;
    if (!uri) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const offset = typeof offsetArg === 'number' ? offsetArg : editor?.document === doc ? doc.offsetAt(editor.selection.active) : -1;
    const entry = entryAt(entriesOf(doc), offset);
    if (!entry) {
      void vscode.window.showInformationMessage('Put the cursor inside a BibTeX entry (@article{…}) to update it.');
      return;
    }
    const q = queryOf(entry);
    if (!q.title && !q.doi) {
      void vscode.window.showWarningMessage(`${entry.key} has no title or DOI to search for.`);
      return;
    }
    const config = settings(uri);
    const sources = config.sources.map((id) => SOURCES.find((s) => s.id === id)).filter((s): s is Source => !!s);
    if (!sources.length) {
      void vscode.window.showWarningMessage('No metadata sources are enabled (texMargin.bibUpdate.sources).');
      return;
    }
    const text = doc.getText();
    const entryText = text.slice(entry.start, entry.end);
    const keys = await secrets();

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Updating ${entry.key}`, cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        const ctx: SourceContext = { http, signal: abort.signal, email: config.email, appId, secret: (id) => keys[id] };
        try {
          return await lookup(entryText, q, sources, ctx, config, {
            progress: (s) => progress.report({ message: `searching ${s.label}…` }),
            pick: (candidates, s, revised) => pickCandidate(entry.key, candidates, s, revised, q.title),
          });
        } catch (e) {
          if (abort.signal.aborted) return undefined;
          throw e;
        }
      },
    );
    if (!result || result.stopped) return;

    const failures = result.errors.map((e) => `${e.source.label}: ${e.message}`);
    if (!result.found) {
      const tried = sources.map((s) => s.label).join(', ');
      const needsKey = result.errors.some((e) => /API key/.test(e.message));
      void vscode.window
        .showWarningMessage(`No match for ${entry.key} on ${tried}.${failures.length ? ` (${failures.join('; ')})` : ''}`, ...(needsKey ? ['Set API Key…'] : []))
        .then((pick) => pick && vscode.commands.executeCommand('texMargin.bibUpdate.setApiKey'));
      return;
    }

    const { source, candidate, merge } = result.found;
    const what = describe(candidate);
    const button = candidate.url ? { label: `Open on ${source.label}`, run: () => vscode.env.openExternal(vscode.Uri.parse(candidate.url!)) } : undefined;
    const note = (failures.length ? ` (${failures.join('; ')})` : '') + skippedNote(merge.skipped);
    if (!merge.changes.length) {
      void vscode.window
        .showInformationMessage(`${entry.key} already matches ${source.label}: ${what}.${note}`, ...(button ? [button.label] : []))
        .then((pick) => {
          if (pick) void button?.run();
        });
      return;
    }
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const proposed = text.slice(0, entry.start) + merge.text.replace(/\r?\n/g, eol) + text.slice(entry.end);
    await previews.show({
      uri,
      original: text,
      proposed,
      title: `${nameOf(uri)} ↔ ${entry.key} from ${source.label} (preview)`,
      message: `${entry.key}: ${what} on ${source.label}. ${changeSummary(merge.changes)}.${note}`,
      button,
      rerun: () => updateEntry(uri, entry.start),
      line: doc.positionAt(entry.start).line,
    });
  }

  /** `revised`: published versions under a changed title, so ask with the user's title in view. */
  async function pickCandidate(key: string, candidates: Candidate[], source: Source, revised = false, yourTitle?: string): Promise<Candidate | 'next' | undefined> {
    type Item = vscode.QuickPickItem & { value: Candidate | 'next' };
    const items: Item[] = candidates.map((c) => ({
      label: c.title,
      description: [c.venue, c.year].filter(Boolean).join(' '),
      detail: `${c.authors.slice(0, 4).join(', ')}${c.authors.length > 4 ? ', …' : ''} · ${c.kind}${c.doi ? ` · ${c.doi}` : ''}`,
      value: c,
    }));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, value: 'next' }, { label: '$(arrow-right) None of these: try the next source', value: 'next' });
    const picked = await vscode.window.showQuickPick(items, {
      title: revised ? `${key}: published under a different title? (${source.label}, same authors)` : `${key}: several matches on ${source.label}`,
      placeHolder: revised ? `Your title: “${yourTitle ?? ''}”` : 'Which one is this entry?',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    return picked?.value;
  }

  async function setApiKey(): Promise<void> {
    const all = SOURCES.flatMap((s) => s.secrets ?? []);
    const keys = await secrets();
    const picked = await vscode.window.showQuickPick(
      all.map((secret) => ({ label: secret.label, description: keys[secret.id] ? '(set)' : '(not set)', detail: secret.detail, secret })),
      { title: 'Set Metadata API Key', placeHolder: 'Stored in VS Code’s secret storage, never in settings.json' },
    );
    if (!picked) return;
    const { secret } = picked;
    const value = await vscode.window.showInputBox({
      title: secret.label,
      prompt: `Get one at ${secret.url} . Leave empty to remove the stored key.`,
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    if (value.trim()) await context.secrets.store(secretKey(secret.id), value.trim());
    else await context.secrets.delete(secretKey(secret.id));
    void vscode.window.showInformationMessage(`${secret.label} ${value.trim() ? 'saved' : 'removed'}.`);
  }

  const codeActions: vscode.CodeActionProvider = {
    provideCodeActions(doc, range) {
      const entry = entryAt(entriesOf(doc), doc.offsetAt(range.start));
      if (!entry) return [];
      // arXiv is only asked about entries that have an arXiv id.
      const hasArxiv = !!queryOf(entry).arxivId;
      const labels = settings(doc.uri)
        .sources.filter((id) => id !== 'arxiv' || hasArxiv)
        .map((id) => SOURCES.find((s) => s.id === id)?.label)
        .filter(Boolean);
      const action = new vscode.CodeAction(`Update ${entry.key} from ${labels.join(', ')}…`, vscode.CodeActionKind.RefactorRewrite);
      action.command = { command: 'texMargin.bibUpdate.entry', title: action.title, arguments: [doc.uri, entry.start] };
      return [action];
    },
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('texMargin.bibUpdate.entry', updateEntry),
    vscode.commands.registerCommand('texMargin.bibUpdate.setApiKey', setApiKey),
    vscode.languages.registerCodeActionsProvider([{ language: 'bibtex', scheme: 'file' }, { language: 'bibtex', scheme: 'untitled' }], codeActions, {
      providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite],
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => parsed.delete(doc.uri.toString())),
  );
  return {
    setFetch: (fn) => http.setFetch(fn),
    async sourceContext(signal, uri) {
      const keys = await secrets();
      return { http, signal, email: settings(uri).email, appId, secret: (id) => keys[id] };
    },
    sources: (uri) => settings(uri).sources.map((id) => SOURCES.find((s) => s.id === id)).filter((s): s is Source => !!s),
    mergeOptions: (uri) => settings(uri),
    pick: pickCandidate,
  };
}

function settings(uri: vscode.Uri) {
  const c = vscode.workspace.getConfiguration('texMargin.bibUpdate', uri);
  return {
    sources: c.get<string[]>('sources', DEFAULT_SOURCES),
    email: c.get<string>('email', '').trim(),
    keepFields: c.get<string[]>('keepFields', []).map((f) => f.toLowerCase()),
    skipFields: c.get<string[]>('skipFields', DEFAULT_SKIP).map((f) => f.toLowerCase()),
    skipDoiUrl: c.get<boolean>('skipDoiUrl', true),
  };
}

/** " Not taken: editor, timestamp (skipFields); url (skipDoiUrl)." — so nothing is dropped silently. */
function skippedNote(skipped: readonly { field: string; reason: string }[]): string {
  if (!skipped.length) return '';
  const byReason = new Map<string, string[]>();
  for (const s of skipped) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.field]);
  return ` Not taken: ${[...byReason].map(([reason, fields]) => `${fields.join(', ')} (${reason})`).join('; ')}.`;
}

function describe(c: Candidate): string {
  const where = [c.venue, c.year].filter(Boolean).join(' ');
  return `“${c.title}”${where ? ` (${where})` : ''}`;
}

/** "type → inproceedings, 2 fields changed (author, title), 3 added, 1 removed" */
export function changeSummary(changes: readonly FieldChange[]): string {
  const of = (kind: FieldChange['kind']) => changes.filter((c) => c.kind === kind);
  const parts: string[] = [];
  const type = of('type')[0];
  if (type) parts.push(`type → ${type.to}`);
  const list = (kind: FieldChange['kind'], word: string) => {
    const fs = of(kind);
    if (fs.length) parts.push(`${fs.length} ${fs.length === 1 ? 'field' : 'fields'} ${word} (${fs.map((f) => f.field).join(', ')})`);
  };
  list('changed', 'changed');
  list('added', 'added');
  list('removed', 'removed');
  return parts.join(', ');
}
