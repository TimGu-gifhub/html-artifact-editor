import type { WebContents } from 'electron';
import { EDITOR_COMMAND, EDITOR_CONNECT, EDITOR_STATE, isEditorRequest } from '../../contracts/editor.ts';
import type { NewFileWriter } from '../../platform/new-file.ts';
import type { InputController } from '../draft/input.ts';
import { executeEditorCommand } from './commands.ts';
import { createEditorTransport } from './transport.ts';

// Single-document bridge for the isolated HAE-005 experiment. The application
// session uses the workspace bridge with explicit document IDs.
export function createEditorBridge(contents: WebContents, input: InputController,
  chooseCopy: () => Promise<string | undefined>, writer: NewFileWriter) {
  return createEditorTransport(contents, { connect: EDITOR_CONNECT, command: EDITOR_COMMAND, state: EDITOR_STATE }, {
    snapshot: input.snapshot, onState: input.onState, isRequest: isEditorRequest,
    execute: (command, active, signal) => executeEditorCommand(input, command, chooseCopy, writer, active, signal),
  });
}
