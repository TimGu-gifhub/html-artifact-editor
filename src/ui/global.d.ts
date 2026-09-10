import type { EditorBootstrap } from '../contracts/bootstrap.ts';
import type { WorkspaceAPI } from '../contracts/workspace-editor.ts';
import type { DesktopAPI } from '../contracts/desktop.ts';

declare global {
  interface Window {
    readonly haeBootstrap?: EditorBootstrap;
    readonly haeWorkspace?: WorkspaceAPI;
    readonly haeDesktop?: DesktopAPI;
  }
}
