import { isTransactionId } from '../../contracts/save-record.ts';

// Main profile ownership excludes other editor processes. This registry also
// excludes two windows/store objects resuming the same sequence in this process.
const owners = new Map<string, Set<string>>();
const operations = new Map<string, number>();
const maintenance = new Set<string>();
export function draftOwnership(namespace: string) {
  const active = (): Set<string> => {
    let sessions = owners.get(namespace);
    if (!sessions) { sessions = new Set(); owners.set(namespace, sessions); }
    return sessions;
  };
  return Object.freeze({
    isActive: (sessionId: string): boolean => owners.get(namespace)?.has(sessionId) ?? false,
    claim(sessionId: string): () => void {
      if (!isTransactionId(sessionId)) throw new Error('DRAFT_CHECKPOINT_INVALID');
      if (maintenance.has(namespace)) throw new Error('DRAFT_STORAGE_MAINTENANCE');
      const sessions = active();
      if (sessions.has(sessionId)) throw new Error('DRAFT_SESSION_ACTIVE');
      sessions.add(sessionId); let released = false;
      return () => {
        if (released) return;
        released = true; sessions.delete(sessionId); if (!sessions.size) owners.delete(namespace);
      };
    },
    claimOperation(): () => void {
      if (maintenance.has(namespace)) throw new Error('STORAGE_MAINTENANCE');
      operations.set(namespace, (operations.get(namespace) ?? 0) + 1); let released = false;
      return () => {
        if (released) return; released = true;
        const count = operations.get(namespace)! - 1;
        if (count) operations.set(namespace, count); else operations.delete(namespace);
      };
    },
    claimMaintenance(): () => void {
      if (maintenance.has(namespace) || owners.get(namespace)?.size || operations.get(namespace)) throw new Error('DRAFT_STORAGE_ACTIVE');
      maintenance.add(namespace); let released = false;
      return () => { if (!released) { released = true; maintenance.delete(namespace); } };
    },
  });
}
