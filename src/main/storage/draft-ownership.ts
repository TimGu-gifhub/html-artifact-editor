import { isTransactionId } from '../../contracts/save-record.ts';

// Main profile ownership excludes other editor processes. This registry also
// excludes two windows/store objects resuming the same sequence in this process.
const owners = new Map<string, Set<string>>();
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
      const sessions = active();
      if (sessions.has(sessionId)) throw new Error('DRAFT_SESSION_ACTIVE');
      sessions.add(sessionId); let released = false;
      return () => {
        if (released) return;
        released = true; sessions.delete(sessionId); if (!sessions.size) owners.delete(namespace);
      };
    },
  });
}
