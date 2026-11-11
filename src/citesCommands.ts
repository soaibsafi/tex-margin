/**
 * Citation health in VS Code: problems for missing / unused / duplicate citations (kept up to date
 * as you type), quick fixes, and two on-demand online checks (retractions, published versions of
 * preprints). The checks themselves are `cites/`; this file is VS Code plumbing.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { Previews } from './bibPreview';
import { BibUpdateApi } from './bibUpdateCommands';
import { normalizeDoi } from './bibupdate/match';
import { mergeEntry, readFetched } from './bibupdate/merge';
import { fieldMap } from './bibupdate/parse';
import { BibItem, Finding, ProjectCheck, SourceFile, checkProject, declaredBibliographies } from './cites/check';
import { findPublished } from './cites/preprints';
import { Notice, checkRetractions } from './cites/retractions';

const SOURCE = 'TeX Margin';
const EXCLUDE = /\/(node_modules|\.git|out|\.vscode-test)\//;

export function registerCitations(context: vscode.ExtensionContext, previews: Previews, update: BibUpdateApi): void {
  const offline = vscode.languages.createDiagnosticCollection('texMargin.citations');
  const online = vscode.languages.createDiagnosticCollection('texMargin.citations.online');
  /** Retraction notices by citation key, from the last online check. */
  const notices = new Map<string, Notice[]>();
  /** File texts from disk, for files that are not open. */
  const diskText = new Map<string, string>();
  let files: vscode.Uri[] | undefined;
  let last: { check: ProjectCheck; texts: Map<string, string> } | undefined;
  let timer: NodeJS.Timeout | undefined;

  // ---------------------------------------------------------------- reading the project

  async function projectFiles(): Promise<vscode.Uri[]> {
    files ??= (await vscode.workspace.findFiles('**/*.{tex,bib}')).filter((u) => !EXCLUDE.test(u.path));
    return files;
  }

  async function textOf(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    const key = uri.toString();
    if (!diskText.has(key)) {
      try {
        diskText.set(key, Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
      } catch {
        return undefined;
      }
    }
    return diskText.get(key);
  }

  /** `fresh`: list and read the files again (explicit commands; edits as you type use the cache). */
  async function runCheck(fresh = false): Promise<ProjectCheck | undefined> {
    if (fresh) {
      files = undefined;
      diskText.clear();
    }
    const config = vscode.workspace.getConfiguration('texMargin.citations');
    if (!config.get('enabled', true)) {
      offline.clear();
      online.clear();
      last = undefined;
      return undefined;
    }
    const all = await projectFiles();
    const texts = new Map<string, string>();
    const read = async (uris: vscode.Uri[]): Promise<SourceFile[]> => {
      const out: SourceFile[] = [];
      for (const uri of uris) {
        const text = await textOf(uri);
        if (text === undefined) continue;
        texts.set(uri.toString(), text);
        out.push({ id: uri.toString(), text });
      }
      return out;
    };
    const tex = await read(all.filter((u) => /\.tex$/i.test(u.path)));
    const bibUris = all.filter((u) => /\.bib$/i.test(u.path));
    // Only the bibliographies the documents name, when they name any.
    const declared = declaredBibliographies(tex, (texId, name) => resolveBib(vscode.Uri.parse(texId), name).toString());
    const used = declared ? bibUris.filter((u) => declared.has(u.toString())) : bibUris;
    const bib = await read(used);
    const check = checkProject(tex, bib, { reportUnused: config.get('reportUnused', true) });
    // A named bibliography outside the workspace (e.g. a global library): keys may be defined there.
    const outside = declared && [...declared].some((d) => !bibUris.some((u) => u.toString() === d));
    if (outside) check.findings = check.findings.filter((f) => f.kind !== 'missing');
    last = { check, texts };
    lineStarts.clear();
    render();
    return check;
  }

  function schedule(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void runCheck(), 500);
  }

  // ---------------------------------------------------------------- diagnostics

  /** Line starts per file of the last check, built on first use. */
  const lineStarts = new Map<string, number[]>();
  function rangeOf(file: string, start: number, end: number): vscode.Range {
    let starts = lineStarts.get(file);
    if (!starts) {
      const text = last?.texts.get(file) ?? '';
      starts = [0];
      for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
      lineStarts.set(file, starts);
    }
    const pos = (offset: number) => {
      let lo = 0;
      let hi = starts!.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts![mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return new vscode.Position(lo, offset - starts![lo]);
    };
    return new vscode.Range(pos(start), pos(end));
  }
  const itemRange = (i: BibItem) => rangeOf(i.file, i.keyStart, i.keyEnd);
  const itemLocation = (i: BibItem) => new vscode.Location(vscode.Uri.parse(i.file), itemRange(i));

  function diagnostic(f: Finding): [string, vscode.Diagnostic] {
    switch (f.kind) {
      case 'missing': {
        const d = new vscode.Diagnostic(rangeOf(f.at.file, f.at.start, f.at.end), `No BibTeX entry for "${f.key}".${f.suggestion ? ` Did you mean "${f.suggestion}"?` : ''}`, vscode.DiagnosticSeverity.Warning);
        d.code = 'missing-citation';
        return [f.at.file, d];
      }
      case 'unused': {
        const d = new vscode.Diagnostic(itemRange(f.item), `"${f.item.key}" is never cited.`, vscode.DiagnosticSeverity.Information);
        d.code = 'unused-entry';
        d.tags = [vscode.DiagnosticTag.Unnecessary];
        return [f.item.file, d];
      }
      case 'duplicateKey': {
        const d = new vscode.Diagnostic(itemRange(f.item), `"${f.item.key}" is defined twice; BibTeX uses the first definition.`, vscode.DiagnosticSeverity.Error);
        d.code = 'duplicate-key';
        d.relatedInformation = [new vscode.DiagnosticRelatedInformation(itemLocation(f.first), 'first definition')];
        return [f.item.file, d];
      }
      case 'samePaper': {
        const others = f.others.map((o) => `"${o.key}"`).join(', ');
        const d = new vscode.Diagnostic(itemRange(f.item), `Same paper as ${others} (same ${f.reason}).`, vscode.DiagnosticSeverity.Warning);
        d.code = 'same-paper';
        d.relatedInformation = f.others.map((o) => new vscode.DiagnosticRelatedInformation(itemLocation(o), `"${o.key}"`));
        return [f.item.file, d];
      }
    }
  }

  function render(): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const add = (file: string, d: vscode.Diagnostic) => {
      d.source = SOURCE;
      byFile.set(file, [...(byFile.get(file) ?? []), d]);
    };
    for (const f of last?.check.findings ?? []) add(...diagnostic(f));
    offline.clear();
    for (const [file, ds] of byFile) offline.set(vscode.Uri.parse(file), ds);

    // Online results follow their keys to wherever the entries are now.
    online.clear();
    const onlineByFile = new Map<string, vscode.Diagnostic[]>();
    for (const [key, list] of notices) {
      const item = last?.check.entries.get(key);
      if (!item) continue;
      const n = list[0];
      const when = n.year ? `${n.year}, ` : '';
      const message =
        n.status === 'retracted'
          ? `"${key}" was retracted (${when}${n.label}, notice ${n.doi}).`
          : n.status === 'concern'
            ? `"${key}" has an expression of concern (${when}notice ${n.doi}).`
            : `"${key}" has a ${n.label.toLowerCase()} (${when}notice ${n.doi}).`;
      const severity = n.status === 'retracted' ? vscode.DiagnosticSeverity.Error : n.status === 'concern' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
      const d = new vscode.Diagnostic(itemRange(item), message, severity);
      d.source = SOURCE;
      d.code = { value: n.status, target: vscode.Uri.parse(`https://doi.org/${n.doi}`) };
      onlineByFile.set(item.file, [...(onlineByFile.get(item.file) ?? []), d]);
    }
    for (const [file, ds] of onlineByFile) online.set(vscode.Uri.parse(file), ds);
  }

  // ---------------------------------------------------------------- quick fixes

  const findingsAt = (uri: vscode.Uri, range: vscode.Range): Finding[] =>
    (last?.check.findings ?? []).filter((f) => {
      const [file, d] = diagnostic(f);
      return file === uri.toString() && d.range.intersection(range) !== undefined;
    });

  const codeActions: vscode.CodeActionProvider = {
    provideCodeActions(doc, range) {
      const actions: vscode.CodeAction[] = [];
      for (const f of findingsAt(doc.uri, range)) {
        if (f.kind === 'missing' && f.suggestion) {
          const a = new vscode.CodeAction(`Change to "${f.suggestion}"`, vscode.CodeActionKind.QuickFix);
          a.edit = new vscode.WorkspaceEdit();
          a.edit.replace(doc.uri, rangeOf(f.at.file, f.at.start, f.at.end), f.suggestion);
          a.isPreferred = true;
          actions.push(a);
        }
        if (f.kind === 'unused' || f.kind === 'duplicateKey') {
          const a = new vscode.CodeAction(f.kind === 'unused' ? `Remove unused entry "${f.item.key}"` : `Remove this definition of "${f.item.key}"`, vscode.CodeActionKind.QuickFix);
          a.edit = new vscode.WorkspaceEdit();
          a.edit.delete(doc.uri, entryRange(f.item));
          actions.push(a);
        }
        if (f.kind === 'unused') {
          const count = (last?.check.findings ?? []).filter((x) => x.kind === 'unused').length;
          if (count > 1) {
            const a = new vscode.CodeAction(`Remove all ${count} unused entries…`, vscode.CodeActionKind.QuickFix);
            a.command = { command: 'texMargin.citations.removeUnused', title: a.title };
            actions.push(a);
          }
        }
        if (f.kind === 'samePaper') {
          for (const other of f.others) {
            const n = last?.check.citations.get(other.key)?.length ?? 0;
            const a = new vscode.CodeAction(`Keep "${f.item.key}", merge "${other.key}" into it (${n} citation${n === 1 ? '' : 's'} rewritten)…`, vscode.CodeActionKind.QuickFix);
            a.command = { command: 'texMargin.citations.mergeKeys', title: a.title, arguments: [f.item.key, other.key] };
            actions.push(a);
          }
        }
      }
      return actions;
    },
  };

  /** The entry with its line (whitespace up to and including one line break after it). */
  function entryRange(item: BibItem): vscode.Range {
    const text = last?.texts.get(item.file) ?? '';
    const tail = /^[ \t]*\r?\n?/.exec(text.slice(item.entry.end))?.[0].length ?? 0;
    return rangeOf(item.file, item.entry.start, item.entry.end + tail);
  }

  /** `confirm: false` skips the Refactor Preview (integration tests only). */
  async function removeUnused(options?: { confirm?: boolean }): Promise<void> {
    const check = (await runCheck(true)) ?? last?.check;
    const unused = (check?.findings ?? []).filter((f): f is Extract<Finding, { kind: 'unused' }> => f.kind === 'unused');
    if (!unused.length) {
      void vscode.window.showInformationMessage('No unused entries.');
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const f of unused) edit.delete(vscode.Uri.parse(f.item.file), entryRange(f.item), { needsConfirmation: options?.confirm !== false, label: `Remove "${f.item.key}"` });
    // needsConfirmation: VS Code shows its Refactor Preview, with a checkbox per entry.
    await vscode.workspace.applyEdit(edit);
  }

  async function mergeKeys(keepKey: unknown, dropKey: unknown, options?: { confirm?: boolean }): Promise<void> {
    if (typeof keepKey !== 'string' || typeof dropKey !== 'string') return;
    const check = (await runCheck(true)) ?? last?.check;
    const keep = check?.entries.get(keepKey);
    const drop = check?.entries.get(dropKey);
    if (!check || !keep || !drop || !last) return;
    const keepText = last.texts.get(keep.file)!.slice(keep.entry.start, keep.entry.end);
    const dropText = last.texts.get(drop.file)!.slice(drop.entry.start, drop.entry.end);
    // Fill in only what the kept entry lacks.
    const own = [...fieldMap(keep.entry).keys(), 'type'];
    const merged = mergeEntry(keepText, readFetched(dropText), { keepFields: own, skipFields: [] });

    const edit = new vscode.WorkspaceEdit();
    const label = { needsConfirmation: options?.confirm !== false, label: `Merge "${dropKey}" into "${keepKey}"` };
    if (merged.text !== keepText) edit.replace(vscode.Uri.parse(keep.file), rangeOf(keep.file, keep.entry.start, keep.entry.end), merged.text, label);
    edit.delete(vscode.Uri.parse(drop.file), entryRange(drop), label);
    for (const at of check.citations.get(dropKey) ?? []) edit.replace(vscode.Uri.parse(at.file), rangeOf(at.file, at.start, at.end), keepKey, label);
    await vscode.workspace.applyEdit(edit);
  }

  // ---------------------------------------------------------------- online checks

  async function retractions(): Promise<void> {
    const check = await runCheck(true);
    if (!check) {
      void vscode.window.showInformationMessage('Citation checks are turned off (texMargin.citations.enabled).');
      return;
    }
    const cited = [...check.entries.values()].filter((i) => check.citations.has(i.key) || check.citations.size === 0);
    const withDoi = cited.flatMap((i) => (fieldMap(i.entry).get('doi') ? [{ item: i, doi: normalizeDoi(fieldMap(i.entry).get('doi')!) }] : []));
    if (!withDoi.length) {
      void vscode.window.showInformationMessage('None of the cited entries has a DOI to check.');
      return;
    }
    const uri = vscode.Uri.parse(withDoi[0].item.file);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Checking cited papers for retractions (Crossref)', cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        const ctx = await update.sourceContext(abort.signal, uri);
        try {
          return await checkRetractions(
            withDoi.map((w) => w.doi),
            ctx,
            (done) => progress.report({ message: `${done + 1} of ${withDoi.length}`, increment: 100 / withDoi.length }),
          );
        } catch (e) {
          if (abort.signal.aborted) return undefined;
          throw e;
        }
      },
    );
    if (!result) return;
    notices.clear();
    for (const { item, doi } of withDoi) {
      const list = result.notices.get(doi);
      if (list) notices.set(item.key, list);
    }
    render();
    const retracted = [...notices].filter(([, l]) => l[0].status === 'retracted').map(([k]) => k);
    const concern = [...notices].filter(([, l]) => l[0].status === 'concern').map(([k]) => k);
    const noDoi = cited.length - withDoi.length;
    const parts = [
      `Checked ${result.checked} of ${withDoi.length} DOIs.`,
      retracted.length ? `Retracted: ${retracted.join(', ')}.` : 'No retractions.',
      concern.length ? `Expression of concern: ${concern.join(', ')}.` : '',
      result.unchecked.length ? `${result.unchecked.length} not checked (${[...new Set(result.unchecked.map((u) => u.reason))].join('; ')}).` : '',
      noDoi ? `${noDoi} cited ${noDoi === 1 ? 'entry has' : 'entries have'} no DOI.` : '',
    ].filter(Boolean);
    const show = retracted.length || concern.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(parts.join(' '), ...(notices.size ? ['Show Problems'] : [])).then((pick) => pick && vscode.commands.executeCommand('workbench.actions.view.problems'));
  }

  async function preprints(arg?: unknown): Promise<void> {
    let uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri || !/\.bib$/i.test(uri.path)) {
      const bibs = (await projectFiles()).filter((u) => /\.bib$/i.test(u.path));
      if (!bibs.length) {
        void vscode.window.showInformationMessage('No .bib files in this workspace.');
        return;
      }
      const picked = bibs.length === 1 ? { uri: bibs[0] } : await vscode.window.showQuickPick(bibs.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })), { title: 'Find published versions of preprints in…' });
      if (!picked) return;
      uri = picked.uri;
    }
    const target = uri;
    const doc = await vscode.workspace.openTextDocument(target);
    const original = doc.getText();
    const sources = update.sources(target);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Looking for published versions of preprints', cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        const ctx = await update.sourceContext(abort.signal, target);
        try {
          return await findPublished(original, sources, ctx, update.mergeOptions(target), (done, total, key) =>
            progress.report({ message: `${key} (${done + 1} of ${total})`, increment: 100 / total }),
            (key, candidates, source, yourTitle) => update.pick(key, candidates, source, true, yourTitle),
          );
        } catch (e) {
          if (abort.signal.aborted) return undefined;
          throw e;
        }
      },
    );
    if (!result) return;
    const name = path.posix.basename(target.path);
    const notes = [
      result.ambiguous.length ? `Several matches (use Update Entry Metadata on each): ${result.ambiguous.join(', ')}.` : '',
      result.errors.length ? `Skipped sources: ${result.errors.join('; ')}.` : '',
    ].filter(Boolean);
    if (!result.published.length) {
      const total = result.published.length + result.ambiguous.length + result.unpublished.length;
      void vscode.window.showInformationMessage(total ? `No published versions found for the ${total} preprint${total === 1 ? '' : 's'} in ${name}. ${notes.join(' ')}` : `No preprints in ${name}.`);
      return;
    }
    await previews.show({
      uri: target,
      original,
      proposed: result.proposed,
      title: `${name} ↔ published versions (preview)`,
      message: `Published versions of ${result.published.length} preprint${result.published.length === 1 ? '' : 's'}: ${result.published.map((p) => `${p.key} (${p.found.candidate.venue ?? p.found.source.label})`).join(', ')}. ${notes.join(' ')}`,
      rerun: () => preprints(target),
    });
  }

  // ---------------------------------------------------------------- wiring

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tex,bib}');
  const onDisk = (uri: vscode.Uri, created: boolean | undefined) => {
    if (EXCLUDE.test(uri.path)) return;
    diskText.delete(uri.toString());
    if (created !== undefined) files = undefined; // created or deleted: list again
    schedule();
  };
  const isProjectDoc = (d: vscode.TextDocument) => d.uri.scheme === 'file' && /\.(tex|bib)$/i.test(d.uri.path);

  context.subscriptions.push(
    offline,
    online,
    watcher,
    watcher.onDidChange((u) => onDisk(u, undefined)),
    watcher.onDidCreate((u) => onDisk(u, true)),
    watcher.onDidDelete((u) => onDisk(u, false)),
    vscode.workspace.onDidChangeTextDocument((e) => isProjectDoc(e.document) && e.contentChanges.length && schedule()),
    vscode.workspace.onDidCloseTextDocument((d) => isProjectDoc(d) && (diskText.delete(d.uri.toString()), schedule())),
    vscode.workspace.onDidChangeWorkspaceFolders(() => ((files = undefined), schedule())),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('texMargin.citations') && schedule()),
    vscode.languages.registerCodeActionsProvider([{ language: 'latex' }, { language: 'tex' }, { language: 'bibtex' }, { pattern: '**/*.{tex,bib}' }], codeActions, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.commands.registerCommand('texMargin.citations.check', async () => {
      const check = await runCheck(true);
      if (!check) {
        void vscode.window.showInformationMessage('Citation checks are turned off (texMargin.citations.enabled).');
        return;
      }
      const n = (kind: Finding['kind']) => check.findings.filter((f) => f.kind === kind).length;
      const summary = [`${check.entries.size} entries, ${check.citations.size} cited keys`, `${n('missing')} missing`, `${n('unused')} unused`, `${n('duplicateKey')} defined twice`, `${n('samePaper')} same-paper`].join(', ');
      void vscode.commands.executeCommand('workbench.actions.view.problems');
      void vscode.window.showInformationMessage(`Citations: ${summary}.`);
    }),
    vscode.commands.registerCommand('texMargin.citations.removeUnused', removeUnused),
    vscode.commands.registerCommand('texMargin.citations.mergeKeys', mergeKeys),
    vscode.commands.registerCommand('texMargin.citations.retractions', retractions),
    vscode.commands.registerCommand('texMargin.citations.preprints', preprints),
    { dispose: () => clearTimeout(timer) },
  );
  schedule();
}

/** `\bibliography{refs}` in paper/main.tex → paper/refs.bib; absolute paths stay absolute. */
function resolveBib(tex: vscode.Uri, name: string): vscode.Uri {
  if (/^([A-Za-z]:)?[\\/]/.test(name)) return vscode.Uri.file(name);
  return vscode.Uri.joinPath(tex, '..', name);
}
