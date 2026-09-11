import type { EditorBootstrap } from '../contracts/bootstrap.ts';
import type { WorkspaceAPI } from '../contracts/workspace-editor.ts';
import type { DesktopAPI } from '../contracts/desktop.ts';
import type { DecorationAPI } from '../contracts/text-geometry.ts';

declare global {
  interface Window {
    readonly haeBootstrap?: EditorBootstrap;
    readonly haeWorkspace?: WorkspaceAPI;
    readonly haeDesktop?: DesktopAPI;
    /** 只读文字装饰层 API；仅在 Main 的透明装饰窗口中由 preload 公开。 */
    readonly haeDecoration?: DecorationAPI;
  }
}
