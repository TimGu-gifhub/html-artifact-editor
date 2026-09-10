import type { WorkspaceSnapshot } from '../contracts/workspace.ts';
import type { WorkspaceResult } from '../contracts/workspace-editor.ts';
import { describeCode } from './util.ts';

/**
 * Entry switching (HAE-008 product entry). The UI never passes a path: Main
 * reuses the current document's authorized directory and only accepts
 * `switchEntry(documentId, stateRevision)`. Project name/entry shown in the
 * menu are display text only.
 */

export type EntrySwitchBlocker = 'no-document' | 'busy' | 'composing' | 'workspace-busy'
  | 'cleanup-pending' | 'review-required';

/** Gates both the menu item's disabled state and the action's runtime checks. */
export function entrySwitchBlocker(
  state: WorkspaceSnapshot | null,
  options: Readonly<{ busy: boolean; composing: boolean }>,
): EntrySwitchBlocker | null {
  if (!state?.current) return 'no-document';
  if (options.busy) return 'busy';
  if (options.composing) return 'composing';
  if (state.phase !== 'idle') return 'workspace-busy';
  if (state.cleanupPending) return 'cleanup-pending';
  if (state.lastSave?.requiresReview || state.lastDeparture?.requiresReview) return 'review-required';
  return null;
}

export function entrySwitchBlockerText(blocker: EntrySwitchBlocker): string {
  switch (blocker) {
    case 'no-document': return '没有已打开的文档。';
    case 'busy': return '另一个操作正在进行，请稍候。';
    case 'composing': return '正在组词，请先完成当前输入。';
    case 'workspace-busy': return '工作区正忙，请稍候再切换。';
    case 'cleanup-pending': return '有待清理的临时文件，暂不能切换入口。';
    case 'review-required': return '有等待复核的故障记录，暂不能切换入口。';
  }
}

/**
 * Synchronous busy exclusion: a re-render is too late to stop a second click
 * or keypress in the same frame, so the guard must be a ref-held latch that is
 * acquired before any await and always released in finally.
 */
export class BusyGuard {
  private held = false;
  tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }
  release(): void {
    this.held = false;
  }
}

export type EntrySwitchDeps = Readonly<{
  getState: () => WorkspaceSnapshot | null;
  isComposing: () => boolean;
  /** guardFlush-style drain of the real input owner window; false = aborted. */
  flush: () => Promise<boolean>;
  switchEntry: (documentId: string, stateRevision: number) => Promise<WorkspaceResult>;
  showToast: (text: string, kind?: 'info' | 'error') => void;
}>;

function describeSwitchError(code: string | null): string {
  switch (code) {
    case 'STALE_DOCUMENT': return '当前文档已变化，本次切换未执行。';
    case 'WORKSPACE_BUSY': return '工作区正忙，请稍候再切换。';
    default: return describeCode(code);
  }
}

/**
 * Drain input, then ask Main to open its native entry picker for the document
 * that was current when the action started. The document id is pinned before
 * the await; if the current document changed while draining, the action is
 * cancelled and nothing is delivered to the new document. Cancellation and
 * Main errors keep the current preview/draft/input untouched; a successful
 * switch arrives through Workspace onState.
 */
export async function runEntrySwitch(deps: EntrySwitchDeps): Promise<void> {
  const start = deps.getState();
  if (!start?.current) return;
  const startBlocker = entrySwitchBlocker(start, { busy: false, composing: deps.isComposing() });
  if (startBlocker) {
    deps.showToast(`无法切换入口：${entrySwitchBlockerText(startBlocker)}`, 'error');
    return;
  }
  const documentId = start.current.id;
  let flushed: boolean;
  try {
    flushed = await deps.flush();
  } catch {
    deps.showToast('切换入口前需要先完成当前输入；可能正在组词或投递失败，请检查校稿栏。', 'error');
    return;
  }
  if (!flushed) return; // the flush path already explained the failure
  const latest = deps.getState();
  if (!latest?.current || latest.current.id !== documentId) {
    deps.showToast('文档已变化，本次切换入口已取消。');
    return;
  }
  const lateBlocker = entrySwitchBlocker(latest, { busy: false, composing: deps.isComposing() });
  if (lateBlocker) {
    deps.showToast(`无法切换入口：${entrySwitchBlockerText(lateBlocker)}`, 'error');
    return;
  }
  let result: WorkspaceResult;
  try {
    result = await deps.switchEntry(documentId, latest.stateRevision);
  } catch {
    deps.showToast(describeCode('EDITOR_DISCONNECTED'), 'error');
    return;
  }
  // Cancelled picker is not a failure and never a write: keep silent.
  if (result.ok) return;
  deps.showToast(describeSwitchError(result.code), 'error');
}
