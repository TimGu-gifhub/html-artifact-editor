import { basename, dirname, join, resolve } from 'node:path';
import { createNewFileWriter } from '../../platform/new-file.ts';
import { createDraftSession } from '../draft/session.ts';
import { createInputController } from '../draft/input.ts';
import { createProjectPreview } from '../preview/project-preview.ts';
import { createPreviewMapping } from '../preview/source-mapping.ts';
import type { ProjectSource } from '../protocol/project-files.ts';
import type { ProjectSummary } from '../../contracts/resources.ts';

// The Main-native chooser supplies the path. Nothing is exposed to the UI until
// preview, mapping, draft and the authorized new-file writer have all succeeded.
export async function prepareDocument(outputRoot: string, source: ProjectSource, generation: number, signal: AbortSignal) {
  const preview = await createProjectPreview(outputRoot, typeof source === 'string' ? resolve(source) : source, 'proofread', generation, signal);
  const entry = join(preview.grant.root, ...preview.grant.entry.split('/'));
  let mapping: Awaited<ReturnType<typeof createPreviewMapping>> | undefined;
  let input: ReturnType<typeof createInputController> | undefined;
  try {
    mapping = await createPreviewMapping(outputRoot, preview, signal);
    const writer = await createNewFileWriter(dirname(entry));
    signal.throwIfAborted();
    const draft = createDraftSession(outputRoot, mapping);
    input = createInputController(mapping, draft);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!closing) {
        input!.close();
        closing = preview.close();
      }
      return closing;
    };
    const ownedInput = input;
    const project = (): ProjectSummary => Object.freeze({ name: basename(preview.grant.root), entry: preview.grant.entry,
      resources: preview.diagnosticState() });
    const onState = (listener: () => void): (() => void) => {
      const stopInput = ownedInput.onState(listener);
      const stopResources = preview.onDiagnostics(listener);
      return () => { stopInput(); stopResources(); };
    };
    return Object.freeze({ id: preview.identity.sessionId, name: basename(entry), entry, project, onState,
      preview, mapping, draft, input, writer, close });
  } catch (error) {
    input?.close(); mapping?.close();
    await preview.close();
    throw error;
  }
}
export type OpenDocument = Awaited<ReturnType<typeof prepareDocument>>;
