/**
 * Tidy BibTeX in VS Code: a document formatter for .bib files, and "Tidy BibTeX File…", which shows
 * the result in the preview diff (bibPreview.ts) before anything changes. The tidying itself is
 * `bibtidy.ts`.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { TidyOptions, applyChoices, availableChoices, isOn, lineEdits, summarize, tidyBibtex, withIndent } from './bibtidy';
import { Previews } from './bibPreview';

export function registerBibtexTidy(context: vscode.ExtensionContext, previews: Previews): void {
  const output = vscode.window.createOutputChannel('TeX Margin: BibTeX Tidy');
  const nameOf = (uri: vscode.Uri) => path.posix.basename(uri.path);

  function log(name: string, warnings: { message: string }[]): void {
    if (!warnings.length) return;
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${name}`);
    for (const w of warnings) output.appendLine(`  ${w.message}`);
  }

  function indentOf(doc: vscode.TextDocument): { insertSpaces: boolean; tabSize: number } | undefined {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    const { insertSpaces, tabSize } = editor?.options ?? {};
    return typeof insertSpaces === 'boolean' && typeof tabSize === 'number' ? { insertSpaces, tabSize } : undefined;
  }

  async function tidyFile(arg?: unknown): Promise<void> {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri || (uri.scheme !== 'file' && uri.scheme !== 'untitled')) {
      void vscode.window.showInformationMessage('Open a .bib file to tidy it.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const name = nameOf(uri);
    const config = settings(uri);
    let options = withIndent(config.options, indentOf(doc));

    if (config.chooseEachTime) {
      const offered = availableChoices(options);
      const picked = await vscode.window.showQuickPick(
        offered.map((choice) => ({ label: choice.label, detail: choice.detail, picked: isOn(options, choice), choice })),
        {
          canPickMany: true,
          ignoreFocusOut: true,
          title: `Tidy ${name}`,
          placeHolder: 'Spacing, indentation and field-name case are always tidied. Defaults: texMargin.bibtexTidy.options',
        },
      );
      if (!picked) return;
      options = applyChoices(options, offered, new Set(picked.map((p) => p.choice.key)));
    }

    const original = doc.getText();
    let outcome;
    try {
      outcome = await tidyBibtex(original, options);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not tidy ${name}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const summary = summarize(outcome, options);
    log(name, outcome.warnings);
    const button = outcome.warnings.length ? { label: 'Show Warnings', run: () => output.show(true) } : undefined;

    if (!outcome.changed) {
      void vscode.window.showInformationMessage(`${name} is already tidy (${summary}).`, ...(button ? [button.label] : [])).then((pick) => pick && output.show(true));
      return;
    }
    await previews.show({
      uri,
      original,
      proposed: outcome.text,
      title: `${name} ↔ Tidied (preview)`,
      message: `${summary}.`,
      button,
      rerun: () => tidyFile(uri),
    });
  }

  // ---------------------------------------------------------------- formatter (Format Document)

  const formatter: vscode.DocumentFormattingEditProvider = {
    async provideDocumentFormattingEdits(doc, fmt) {
      const text = doc.getText();
      try {
        const out = await tidyBibtex(text, withIndent(settings(doc.uri).options, fmt));
        log(nameOf(doc.uri), out.warnings);
        return lineEdits(text, out.text).map((e) => vscode.TextEdit.replace(new vscode.Range(e.start[0], e.start[1], e.end[0], e.end[1]), e.text));
      } catch (e) {
        void vscode.window.showErrorMessage(`Could not format ${nameOf(doc.uri)}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    },
  };
  let formatterRegistration: vscode.Disposable | undefined;
  const updateFormatter = () => {
    const enabled = vscode.workspace.getConfiguration('texMargin.bibtexTidy').get('formatter', true);
    if (enabled && !formatterRegistration) {
      formatterRegistration = vscode.languages.registerDocumentFormattingEditProvider(
        [
          { language: 'bibtex', scheme: 'file' },
          { language: 'bibtex', scheme: 'untitled' },
        ],
        formatter,
      );
    } else if (!enabled && formatterRegistration) {
      formatterRegistration.dispose();
      formatterRegistration = undefined;
    }
  };
  updateFormatter();

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('texMargin.tidyBib', tidyFile),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('texMargin.bibtexTidy.formatter') && updateFormatter()),
    { dispose: () => formatterRegistration?.dispose() },
  );
}

function settings(uri: vscode.Uri): { options: TidyOptions; chooseEachTime: boolean } {
  const c = vscode.workspace.getConfiguration('texMargin.bibtexTidy', uri);
  return { options: { ...(c.get<TidyOptions>('options') ?? {}) }, chooseEachTime: c.get('chooseEachTime', true) };
}
