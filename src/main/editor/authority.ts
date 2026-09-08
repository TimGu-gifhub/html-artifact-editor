import type { IpcMainInvokeEvent, Session, WebContents, WebFrameMain } from 'electron';
import { EDITOR_URL } from '../../contracts/editor.ts';

export type EditorAuthority = Readonly<{
  contents: WebContents; session: Session; frame: () => WebFrameMain | null; isActive: () => boolean;
}>;
export function acceptsEditorSender(authority: EditorAuthority, event: IpcMainInvokeEvent): boolean {
  try {
    const pinned = authority.frame();
    return authority.isActive() && !authority.contents.isDestroyed() && event.sender === authority.contents
      && event.sender.session === authority.session && event.senderFrame !== null
      && event.senderFrame === authority.contents.mainFrame && (!pinned || event.senderFrame === pinned)
      && !event.senderFrame.detached && event.senderFrame.url === EDITOR_URL && event.sender.getURL() === EDITOR_URL;
  } catch { return false; }
}
