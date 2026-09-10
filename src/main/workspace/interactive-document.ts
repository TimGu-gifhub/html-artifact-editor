import { basename, join } from 'node:path';
import type { HistoryCheckpoint } from '../../core/history/timeline.ts';
import type { ProjectSummary } from '../../contracts/resources.ts';
import type { ProjectSource } from '../protocol/project-files.ts';
import { createProjectPreview } from '../preview/project-preview.ts';
import { openSaveSource } from '../../platform/save-source.ts';

// Read-only is an explicit document kind. It has no mapping, input controller,
// Patch candidate, writer or storage owner. Its DOM can never become a draft.
export async function prepareInteractiveDocument(outputRoot: string, source: ProjectSource, generation: number,
  signal: AbortSignal, historyContinuation?: HistoryCheckpoint) {
  const preview = await createProjectPreview(outputRoot, source, 'interactive', generation, signal);
  try {
    const entry = join(preview.grant.root, ...preview.grant.entry.split('/'));
    const saveSource = await openSaveSource(entry, preview.sourceBytes());
    await saveSource.verify(); signal.throwIfAborted();
    const project = (): ProjectSummary => Object.freeze({ name: basename(preview.grant.root), entry: preview.grant.entry,
      resources: preview.diagnosticState() });
    return Object.freeze({ id: preview.identity.sessionId, mode: 'interactive' as const, name: basename(entry), entry,
      preview, saveSource, project, onState: preview.onDiagnostics, close: preview.close, historyContinuation,
      input: null, mapping: null, draft: null, writer: null, sourceDiff: null, history: null,
      persistence: null, checkpointSessionId: null, verifyRecovery: null });
  } catch (error) { await preview.close(); throw error; }
}
export type InteractiveDocument = Awaited<ReturnType<typeof prepareInteractiveDocument>>;
