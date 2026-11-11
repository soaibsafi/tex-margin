import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { gitBlobHash } from './diff';

const run = promisify(execFile);
const HASH = /^[0-9a-f]{40}$/;
const decoder = new TextDecoder('utf-8'); // strips a BOM, like VS Code does

/**
 * Where layer 3 gets the old text an anchor's offsets refer to, by hash:
 *  1. a snapshot this extension saved (private extension storage, never in the repo), covering
 *     uncommitted states such as edits made right before closing VS Code;
 *  2. git's object store (`git cat-file blob <hash>`), covering any committed or staged version,
 *     including the one a collaborator commented on.
 */
export class History {
  private readonly dir: vscode.Uri | undefined;
  private readonly saved = new Set<string>();

  /** `folder`: comments use 'snapshots'; submitted versions of reviewed papers use 'baselines'. */
  constructor(storageUri: vscode.Uri | undefined, folder = 'snapshots') {
    this.dir = storageUri && vscode.Uri.joinPath(storageUri, folder);
  }

  /** Save snapshots of `texts` (by hash) without deleting any others. */
  async keep(texts: Map<string, string>): Promise<void> {
    if (!this.dir) return;
    await vscode.workspace.fs.createDirectory(this.dir);
    for (const [hash, text] of texts) {
      if (this.saved.has(hash)) continue;
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.dir, hash), Buffer.from(text, 'utf8'));
      this.saved.add(hash);
    }
  }

  async load(hash: string | undefined, cwd: string | undefined): Promise<{ text: string; source: 'snapshot' | 'git' } | undefined> {
    if (!hash || !HASH.test(hash)) return undefined;
    if (this.dir) {
      try {
        const text = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir, hash)));
        if (gitBlobHash(text) === hash) return { text, source: 'snapshot' };
      } catch {
        this.saved.delete(hash); // no snapshot (any more)
      }
    }
    if (cwd) {
      try {
        const { stdout } = await run('git', ['cat-file', 'blob', hash], {
          cwd,
          encoding: 'buffer',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 5000,
        });
        const text = decoder.decode(stdout);
        if (gitBlobHash(text) === hash) return { text, source: 'git' };
      } catch {
        // not a git repo, git missing, or blob unknown
      }
    }
    return undefined;
  }

  /** Keep a snapshot of every text the stored anchors refer to, and delete the rest. */
  async sync(texts: Map<string, string>): Promise<void> {
    if (!this.dir) return;
    await vscode.workspace.fs.createDirectory(this.dir);
    for (const [hash, text] of texts) {
      if (this.saved.has(hash)) continue;
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.dir, hash), Buffer.from(text, 'utf8'));
      this.saved.add(hash);
    }
    for (const [name] of await vscode.workspace.fs.readDirectory(this.dir)) {
      if (!texts.has(name)) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.dir, name)).then(undefined, () => undefined);
        this.saved.delete(name);
      }
    }
  }
}
