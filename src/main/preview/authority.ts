import type { IpcMainEvent, Session, WebContents } from 'electron';
import type { PreviewIdentity } from '../../contracts/preview.ts';
import { isPreviewReady } from '../../contracts/preview.ts';

export type PreviewAuthority = Readonly<{
  contents: WebContents;
  session: Session;
  url: string;
  identity: PreviewIdentity;
  isActive: () => boolean;
}>;

// This guard grants only acknowledgement of startup. There is no save channel.
export function acceptsPreviewReady(authority: PreviewAuthority, event: IpcMainEvent, payload: unknown): boolean {
  if (!authority.isActive() || authority.contents.isDestroyed() || !isPreviewReady(payload)) return false;
  try {
    return event.sender === authority.contents && event.sender.session === authority.session
      && event.senderFrame !== null && event.senderFrame === authority.contents.mainFrame
      && event.senderFrame.url === authority.url && event.sender.getURL() === authority.url
      && payload.sessionId === authority.identity.sessionId
      && payload.generation === authority.identity.generation && payload.mode === authority.identity.mode;
  } catch { return false; } // Destroyed/navigating frames cannot authorize anything.
}
