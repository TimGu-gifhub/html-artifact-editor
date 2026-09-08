import { basename, dirname, resolve } from 'node:path';
import { createNewFileWriter } from '../../platform/new-file.ts';
import { createDraftSession } from '../draft/session.ts';
import { createInputController } from '../draft/input.ts';
import { createProjectPreview } from '../preview/project-preview.ts';
import { createPreviewMapping } from '../preview/source-mapping.ts';

// The Main-native chooser supplies the path. Nothing is exposed to the UI until
// preview, mapping, draft and the authorized new-file writer have all succeeded.
export async function prepareDocument(outputRoot: string, path: string, generation: number, signal: AbortSignal) {
  const entry = resolve(path);
  const preview = await createProjectPreview(outputRoot, entry, 'proofread', generation, signal);
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
    return Object.freeze({ id: preview.identity.sessionId, name: basename(entry), entry,
      preview, mapping, draft, input, writer, close });
  } catch (error) {
    input?.close(); mapping?.close();
    await preview.close();
    throw error;
  }
}
export type OpenDocument = Awaited<ReturnType<typeof prepareDocument>>;
