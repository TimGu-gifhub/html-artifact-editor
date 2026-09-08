import { spawn } from 'node:child_process';
import { isAbsolute, dirname, basename, resolve } from 'node:path';
import { isStoredFileIdentity, isTransactionId } from '../contracts/save-record.ts';
import type { StoredFileIdentity } from '../contracts/save-record.ts';
import { MAX_SOURCE_BYTES } from '../contracts/source-tree.ts';
import { checkedDirectory, digest } from './storage-files.ts';
import type { SaveSource } from './save-source.ts';

export type ReplacementResult = Readonly<{ status: 'committed' | 'failed' | 'unknown'; code: string | null; cleanupPending: boolean }>;
export type ReplacementHooks = Readonly<{
  beforeReplace: () => Promise<void>;
  afterReplace: (identity: StoredFileIdentity) => Promise<void>;
  onStep: (step: string) => Promise<void>;
}>;
export type SourceReplacer = (source: SaveSource, transactionId: string, bytes: Uint8Array, hooks: ReplacementHooks) => Promise<ReplacementResult>;
const outcome = (status: ReplacementResult['status'], code: string | null, cleanupPending = true): ReplacementResult =>
  Object.freeze({ status, code, cleanupPending });
const map = (value: unknown, count: number): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === count;
const safeCode = (value: unknown): string => typeof value === 'string' && /^[A-Z_0-9]{1,80}$/u.test(value) ? value : 'NATIVE_FAILED';

// Main supplies the helper from its trusted installation, never cwd, a journal,
// project or renderer input. This factory pins its verified bytes for this run.
export async function createWindowsReplacer(helperPath: string): Promise<SourceReplacer> {
  if (process.platform !== 'win32') throw new Error('SAVE_PLATFORM_UNSUPPORTED');
  if (!isAbsolute(helperPath) || basename(helperPath) !== 'ReplaceHelper.exe') throw new Error('SAVE_INVALID_HELPER');
  const helperFolder = await checkedDirectory(dirname(helperPath));
  const helper = await helperFolder.read('ReplaceHelper.exe', MAX_SOURCE_BYTES);
  return async (source, transactionId, input, hooks) => {
    const bytes = new Uint8Array(input); const newHash = digest(bytes);
    if (!isTransactionId(transactionId) || bytes.length > MAX_SOURCE_BYTES || newHash === source.baseHash) return outcome('failed', 'SAVE_INVALID_CANDIDATE');
    try {
      if ((await helperFolder.read('ReplaceHelper.exe', MAX_SOURCE_BYTES)).hash !== helper.hash) throw new Error('SAVE_HELPER_CHANGED');
      await source.verify(); const folder = await checkedDirectory(dirname(source.path));
      if (JSON.stringify(folder.identityChain) !== JSON.stringify(source.directoryIdentities)) throw new Error('FILE_CHANGED');
      const temp = await folder.writeReplacement(transactionId, bytes, (step) => hooks.onStep(`temp-${step}`));
      await source.verify();
      const child = spawn(resolve(helperPath), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
      let exited = false, sentReplace = false, journaled = false, protocolFailed = false;
      const closed = new Promise<void>((done) => child.once('close', () => { exited = true; done(); }));
      child.on('error', () => { protocolFailed = true; });
      child.stdin.on('error', () => { protocolFailed = true; });
      const timer = setTimeout(() => { protocolFailed = true; child.kill(); }, 30000);
      let total = 0;
      child.stderr.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 8192) { protocolFailed = true; child.kill(); } });
      const live = (): void => { if (exited || protocolFailed || child.exitCode !== null) throw new Error('NATIVE_DISCONNECTED'); };
      const guarded = async (work: Promise<void>): Promise<void> => {
        await Promise.race([work, closed.then(() => { throw new Error('NATIVE_DISCONNECTED'); })]); live();
      };
      const send = (value: unknown): void => { live(); child.stdin.write(`${JSON.stringify(value)}\n`); };
      const command = (value: string): void => send({ version: 1, token: transactionId, command: value });
      let terminal: ReplacementResult | undefined; let phase: 'starting' | 'replacing' | 'committing' = 'starting';
      try {
        send({ version: 1, transactionId, path: source.path, oldHash: source.baseHash, newHash,
          directories: source.directoryIdentities, source: source.identity, temp: temp.identity });
        let pending = '';
        for await (const chunk of child.stdout) {
          total += chunk.length; if (total > 8192) throw new Error('NATIVE_PROTOCOL_FAILED');
          pending += chunk.toString('utf8');
          let end: number;
          while ((end = pending.indexOf('\n')) >= 0) {
            const value: unknown = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
            if (terminal || !map(value, 4) || value.version !== 1 || value.token !== transactionId || !map(value.data, Object.keys(value.data ?? {}).length)) throw new Error('NATIVE_PROTOCOL_FAILED');
            const data = value.data;
            if (value.kind === 'ready' && phase === 'starting' && map(data, 0)) {
              await guarded(hooks.onStep('native-ready'));
              await guarded(hooks.beforeReplace());
              sentReplace = true; phase = 'replacing'; command('replace');
            } else if (value.kind === 'replaced' && phase === 'replacing' && map(data, 2)
              && data.resultHash === newHash && isStoredFileIdentity(data.identity)) {
              await guarded(hooks.onStep('native-replaced'));
              await guarded(hooks.afterReplace(Object.freeze({ ...data.identity })));
              journaled = true; live(); phase = 'committing'; command('commit');
            } else if (value.kind === 'done' && phase === 'committing' && [1, 2].includes(Object.keys(data).length)
              && (Object.keys(data).length === 1 || typeof data.code === 'string') && typeof data.cleanupPending === 'boolean') {
              terminal = outcome('committed', null, data.cleanupPending);
            } else if (value.kind === 'failed' && phase !== 'committing' && map(data, 2) && data.cleanupPending === true && typeof data.code === 'string') {
              terminal = outcome('failed', safeCode(data.code));
            } else if (value.kind === 'unknown' && sentReplace && map(data, 2) && data.cleanupPending === true && typeof data.code === 'string') {
              terminal = outcome('unknown', safeCode(data.code));
            } else { throw new Error('NATIVE_PROTOCOL_FAILED'); }
          }
        }
        await closed;
        if (pending.trim() || protocolFailed || !terminal) throw new Error('NATIVE_DISCONNECTED');
        if (terminal.status === 'committed' && child.exitCode !== 0) return outcome('committed', null);
        return terminal;
      } catch (error) {
        // Killing and awaiting close is mandatory: no helper can keep replacing
        // after Main has returned an unknown result. No retry on an uncertain IPC.
        child.kill(); await closed;
        if (journaled) return outcome('committed', null);
        return outcome(sentReplace ? 'unknown' : 'failed', safeCode((error as Error)?.message));
      } finally { clearTimeout(timer); child.stdin.destroy(); }
    } catch (error) { return outcome('failed', safeCode((error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message)); }
  };
}
