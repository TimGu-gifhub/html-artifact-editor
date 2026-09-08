import type { EditorCommand, EditorCopyResult, EditorResult } from '../../contracts/editor.ts';
import type { NewFileWriter } from '../../platform/new-file.ts';
import type { InputController } from '../draft/input.ts';

const publicErrors = new Set(['INPUT_BUSY', 'STALE_INPUT', 'INPUT_COMPOSING', 'INPUT_MAPPING_LOST', 'INPUT_CLOSED',
  'STALE_INPUT_BEGIN', 'STALE_SELECTION', 'STALE_EDIT_INTENT', 'STALE_INPUT_STATE', 'UNAPPLIED_INPUT',
  'DRAFT_UNAVAILABLE', 'STALE_DRAFT_REQUEST', 'TARGET_READ_ONLY', 'DRAFT_PREPARE_CANCELLED',
  'DRAFT_PREPARE_FAILED', 'DRAFT_PREPARE_TIMEOUT', 'DRAFT_OUTCOME_UNKNOWN', 'INVALID_TEXT_NUL',
  'INVALID_UNICODE', 'TEXT_SIZE_LIMIT', 'PATCH_COUNT_LIMIT', 'CANDIDATE_SIZE_LIMIT']);

export async function executeEditorCommand(input: InputController, command: EditorCommand,
  chooseCopy: () => Promise<string | undefined>, writer: NewFileWriter, active: () => boolean,
  signal: AbortSignal): Promise<EditorResult> {
  let code: string | null = null;
  let copy: EditorCopyResult | null = null;
  try {
    switch (command.kind) {
      case 'read': break;
      case 'begin': await input.begin(command.value); break;
      case 'change': input.change(command.value); break;
      case 'apply': await input.apply(command.value); break;
      case 'resolve': await input.resolve(command.value); break;
      case 'save-copy': {
        const outcome = await input.saveCopy(command.stateRevision, () => chooseWhileActive(chooseCopy, active, signal), writer);
        copy = outcome ? input.snapshot().lastCopy! : { status: 'cancelled' };
        if (outcome?.status === 'failed') code = 'COPY_FAILED';
        if (outcome?.status === 'unknown') code = 'COPY_OUTCOME_UNKNOWN';
        break;
      }
    }
  } catch (error) {
    code = error instanceof Error && publicErrors.has(error.message) ? error.message : 'EDITOR_COMMAND_FAILED';
  }
  return { ok: code === null, code, state: input.snapshot(), copy };
}

function chooseWhileActive(choose: () => Promise<string | undefined>, active: () => boolean,
  signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted || !active()) return Promise.resolve(undefined);
  return new Promise((resolveChoice, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', cancel); settle();
    };
    const cancel = (): void => finish(() => resolveChoice(undefined));
    signal.addEventListener('abort', cancel, { once: true });
    void Promise.resolve().then(() => !signal.aborted && active() ? choose() : undefined)
      .then((path) => finish(() => resolveChoice(!signal.aborted && active() ? path : undefined)),
        (error: unknown) => finish(() => reject(error)));
  });
}
