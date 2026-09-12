import type { DesktopCommand } from '../contracts/desktop.ts';
import type { WorkspaceResult } from '../contracts/workspace-editor.ts';
import type { LiveInputController } from './live-input.ts';
import type { WorkspaceStore } from './store.ts';

export type FlushDeps = Readonly<{ owner: boolean; controller: LiveInputController }>;
export type DesktopRequest = (command: DesktopCommand) => Promise<WorkspaceResult>;

/**
 * Before hide/dock/open/save/save-copy/PDF: drain the latest local input.
 *
 * Never guess from a Main snapshot that no input is pending:
 * - Owner side always drains through its own controller — Main having no
 *   input cannot see a preserved local failure (controller.failed) or an
 *   in-flight begin, and flush() already settles both honestly.
 * - Non-owner side always asks Main to route a flush request to the owner
 *   window — the floating/contextual/inline window's begin may be in flight
 *   before Main has any input at all. Owner 归属：主窗口仅 docked/hidden；
 *   floating/contextual 为 editor 窗口；inline 为原位输入窗（role=inline）。
 *
 * Returns false without retry when composing or failed; the caller must abort
 * its own action.
 */
export async function ensureInputFlushed(
  deps: FlushDeps,
  store: WorkspaceStore,
  request: DesktopRequest | null,
): Promise<boolean> {
  if (deps.owner) return deps.controller.flush();
  if (!request) return false;
  try {
    const result = await request({ kind: 'flush-input' });
    if (!result.ok) return false;
  } catch {
    return false;
  }
  const seen = await store.waitFor(
    snap => !!snap.desktop?.flush || !snap.current?.input?.hasUnappliedInput,
    10000,
  );
  if (!seen) return false;
  if (!seen.current?.input?.hasUnappliedInput) return true;
  const final = await store.waitFor(snap => !snap.desktop?.flush, 20000);
  if (!final) return false;
  const input = final.current?.input;
  return !input?.input || !input.hasUnappliedInput;
}
