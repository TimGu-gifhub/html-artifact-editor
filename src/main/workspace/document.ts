import { basename, dirname, join, resolve } from 'node:path';
import { createNewFileWriter } from '../../platform/new-file.ts';
import { createDraftSession } from '../draft/session.ts';
import { createInputController } from '../draft/input.ts';
import { createProjectPreview } from '../preview/project-preview.ts';
import { createPreviewMapping } from '../preview/source-mapping.ts';
import type { ProjectSource } from '../protocol/project-files.ts';
import type { ProjectSummary } from '../../contracts/resources.ts';
import { openSaveSource } from '../../platform/save-source.ts';
import { createDraftPersistence } from '../draft/persistence.ts';
import type { createDraftCheckpointStore } from '../storage/checkpoints.ts';

export type DraftStore = Awaited<ReturnType<typeof createDraftCheckpointStore>>;

// The Main-native chooser supplies the path. Nothing is exposed to the UI until
// preview, mapping, draft and the authorized new-file writer have all succeeded.
export async function prepareDocument(outputRoot: string, source: ProjectSource, generation: number, signal: AbortSignal, checkpoints?: DraftStore) {
  const preview = await createProjectPreview(outputRoot, typeof source === 'string' ? resolve(source) : source, 'proofread', generation, signal);
  const entry = join(preview.grant.root, ...preview.grant.entry.split('/'));
  let mapping: Awaited<ReturnType<typeof createPreviewMapping>> | undefined;
  let input: ReturnType<typeof createInputController> | undefined;
  try {
    mapping = await createPreviewMapping(outputRoot, preview, signal);
    const saveSource = await openSaveSource(entry, mapping.source.bytes);
    const writer = await createNewFileWriter(dirname(entry));
    await saveSource.verify();
    signal.throwIfAborted();
    const index = mapping.source;
    const persistence = checkpoints ? createDraftPersistence((candidate, revision) =>
      checkpoints.write(saveSource, index, candidate, preview.identity.sessionId, revision)) : null;
    const draft = createDraftSession(outputRoot, mapping, undefined, persistence ?? undefined);
    input = createInputController(mapping, draft);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!closing) {
        input!.close();
        closing = (async () => { await persistence?.close(); await preview.close(); })();
      }
      return closing;
    };
    const ownedInput = input;
    const project = (): ProjectSummary => Object.freeze({ name: basename(preview.grant.root), entry: preview.grant.entry,
      resources: preview.diagnosticState() });
    const onState = (listener: () => void): (() => void) => {
      const stopInput = ownedInput.onState(listener);
      const stopResources = preview.onDiagnostics(listener);
      const stopPersistence = persistence?.onState(listener);
      return () => { stopInput(); stopResources(); stopPersistence?.(); };
    };
    return Object.freeze({ id: preview.identity.sessionId, name: basename(entry), entry, project, onState,
      preview, mapping, draft, input, writer, saveSource, persistence, close });
  } catch (error) {
    input?.close(); mapping?.close();
    await preview.close();
    throw error;
  }
}
export type OpenDocument = Awaited<ReturnType<typeof prepareDocument>>;
