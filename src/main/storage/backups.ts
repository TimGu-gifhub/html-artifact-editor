import { isRestoreReference } from '../../contracts/save-record.ts';
import type { BackupCatalog, BackupSummary } from '../../contracts/backup.ts';
import type { RestoreReference } from '../../contracts/save-record.ts';
import type { SaveSource } from '../../platform/save-source.ts';
import type { createSavePreparationStore } from './preparation.ts';
import { executeOriginalSave } from './original.ts';
import type { OriginalSaveResult } from './original.ts';

// A Main service, never a path or raw-record interface for the renderer.
export function createBackupRestorer(store: Awaited<ReturnType<typeof createSavePreparationStore>>) {
  return Object.freeze({
    async list(source: SaveSource): Promise<BackupCatalog> {
      await source.verify();
      const catalog = await store.scan(); const entries: BackupSummary[] = [];
      let reviewRequired = catalog.unrecognized;
      for (const row of catalog.records) {
        if (row.phase === 'abandoned') continue;
        if (row.phase === 'invalid' || row.phase === 'incomplete') { reviewRequired = true; continue; }
        if (row.intent?.targetKey !== source.targetKey) continue;
        if (entries.length >= 20) throw new Error('BACKUP_LIMIT');
        entries.push((await store.reviewBackup(source, row.transactionId)).summary);
      }
      await source.verify();
      entries.sort((a, b) => b.createdAt - a.createdAt || a.reference.transactionId.localeCompare(b.reference.transactionId));
      return Object.freeze({ entries: Object.freeze(entries), locked: catalog.locked, reviewRequired });
    },
    async review(source: SaveSource, reference: RestoreReference) {
      if (!isRestoreReference(reference)) throw new Error('BACKUP_RECORD_INVALID');
      const selected = await store.reviewBackup(source, reference.transactionId);
      if (selected.summary.reference.intentHash !== reference.intentHash) throw new Error('BACKUP_RECORD_CHANGED');
      let result: Promise<OriginalSaveResult> | undefined;
      return Object.freeze({ backup: selected.summary, get bytes() { return selected.bytes; },
        restore: (signal: AbortSignal): Promise<OriginalSaveResult> =>
          result ??= executeOriginalSave(store, selected.summary.hash, signal, selected.prepare) });
    },
  });
}
export type BackupRestorer = ReturnType<typeof createBackupRestorer>;
