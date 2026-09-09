import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute } from 'node:path';
import { isStoredFileIdentity, isTransactionId, sameStoredIdentity } from '../contracts/save-record.ts';
import { MAX_SOURCE_BYTES } from '../contracts/source-tree.ts';
import { checkedDirectory } from './storage-files.ts';
import type { SaveSource } from './save-source.ts';

export type SaveRecoveryGuard = (source: SaveSource, transactionId: string, work: (assertLive: () => void) => Promise<void>) => Promise<void>;
const map = (value: unknown, count: number): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === count;
// The trusted native helper only opens the authorized HTML for reading in this
// mode, excluding write/delete handles until Main finishes its private decision.
export async function createWindowsRecoveryGuard(helperPath: string): Promise<SaveRecoveryGuard> {
  if (process.platform !== 'win32') throw new Error('SAVE_PLATFORM_UNSUPPORTED');
  if (!isAbsolute(helperPath) || basename(helperPath) !== 'ReplaceHelper.exe') throw new Error('SAVE_INVALID_HELPER');
  const folder = await checkedDirectory(dirname(helperPath)); const helper = await folder.read('ReplaceHelper.exe', MAX_SOURCE_BYTES);
  return async (source, transactionId, work) => {
    if (!isTransactionId(transactionId)) throw new Error('SAVE_RECOVERY_INVALID');
    if ((await folder.read('ReplaceHelper.exe', MAX_SOURCE_BYTES)).hash !== helper.hash) throw new Error('SAVE_HELPER_CHANGED');
    await source.verify();
    const child = spawn(helperPath, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let exited = false; let failed = false; let total = 0;
    const closed = new Promise<void>(done => child.once('close', () => { exited = true; done(); }));
    child.on('error', () => { failed = true; }); child.stdin.on('error', () => { failed = true; });
    child.stderr.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 8192) { failed = true; child.kill(); } });
    const timer = setTimeout(() => { failed = true; child.kill(); }, 30000);
    const live = (): void => { if (failed || exited || child.exitCode !== null || child.signalCode !== null) throw new Error('SAVE_RECOVERY_GUARD_LOST'); };
    let phase: 'starting' | 'guarded' | 'finished' = 'starting'; let pending = '';
    try {
      live(); child.stdin.write(`${JSON.stringify({ version: 1, mode: 'review', transactionId, path: source.path,
        hash: source.baseHash, directories: source.directoryIdentities, source: source.identity })}\n`);
      for await (const chunk of child.stdout) {
        total += chunk.length; if (total > 8192) throw new Error('SAVE_RECOVERY_GUARD_PROTOCOL');
        pending += chunk.toString('utf8'); let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const value: unknown = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
          if (!map(value, 4) || value.version !== 1 || value.token !== transactionId) throw new Error('SAVE_RECOVERY_GUARD_PROTOCOL');
          if (value.kind === 'failed') throw new Error('SAVE_RECOVERY_FILE_BUSY_OR_CHANGED');
          if (!map(value.data, 2) || value.data.hash !== source.baseHash || !isStoredFileIdentity(value.data.identity)
            || !sameStoredIdentity(value.data.identity, source.identity)) throw new Error('SAVE_RECOVERY_GUARD_PROTOCOL');
          if (phase === 'starting' && value.kind === 'guarded') {
            phase = 'guarded'; live(); await work(live); live();
            child.stdin.write(`${JSON.stringify({ version: 1, token: transactionId, command: 'finish-review' })}\n`);
          } else if (phase === 'guarded' && value.kind === 'reviewed') { phase = 'finished'; }
          else throw new Error('SAVE_RECOVERY_GUARD_PROTOCOL');
        }
      }
      await closed;
      if (failed || child.exitCode !== 0 || pending.trim() || phase !== 'finished') throw new Error('SAVE_RECOVERY_GUARD_LOST');
    } finally {
      clearTimeout(timer); if (!exited) child.kill(); await closed; child.stdin.destroy();
    }
  };
}
