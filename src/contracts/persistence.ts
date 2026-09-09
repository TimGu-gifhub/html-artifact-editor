export type DraftPersistenceState = Readonly<{
  status: 'idle' | 'writing' | 'persisted' | 'failed' | 'unknown';
  draftRevision: number; writingRevision: number | null; queuedRevision: number | null;
  persisted: Readonly<{ draftRevision: number; resultHash: string }> | null;
  code: string | null; cleanupPending: boolean; canRetry: boolean;
}>;
