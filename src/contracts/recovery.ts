// A catalog is a bounded summary, never a file grant or a promise that a source
// can be restored. Main reauthorizes and verifies the selected file on restore.
export type WorkspaceRecoveryCatalog = Readonly<{
  entries: readonly Readonly<{
    sessionId: string; name: string; draftRevision: number;
    status: 'dirty' | 'clean' | 'saved' | 'retired' | 'incomplete' | 'invalid' | 'ambiguous';
    active: boolean;
  }>[];
  locked: boolean; reviewRequired: boolean;
}>;
