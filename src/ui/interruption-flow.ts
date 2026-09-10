import type { WorkspaceSnapshot } from '../contracts/workspace.ts';
import type { InterruptionState } from '../contracts/interruption.ts';
import type { WorkspaceResult } from '../contracts/workspace-editor.ts';
import { describeCode } from './util.ts';

/**
 * Interruption check flow (HAE-010/011 product entry). The renderer only sends
 * `inspect-interruption` with the LATEST workspace revision; Main owns the
 * native source picker, the independently bound confirmation and every write.
 * The UI never passes a path, lock, transaction id or reviewId, never decides
 * from a snapshot that no input is pending, and never treats WorkspaceResult
 * .ok as a check/repair success — the outcome arrives through onState as
 * desktop.interruption.result.
 */

/** Maintenance gate for every other action: Main is checking or the result needs review. */
export type InterruptionGate = 'main-busy' | 'review-required';

export function interruptionGate(state: WorkspaceSnapshot | null): InterruptionGate | null {
  const interruption = state?.desktop?.interruption;
  if (!interruption) return null;
  if (interruption.phase !== 'idle') return 'main-busy';
  if (interruption.requiresReview) return 'review-required';
  return null;
}

export function interruptionGateText(gate: InterruptionGate): string {
  switch (gate) {
    case 'main-busy': return '正在检查上次中断，其他操作暂不可用。';
    case 'review-required': return '上次中断处理的结果需要人工检查，其他操作暂不可用；可在“检查上次中断”中查看。';
  }
}

export type InterruptionBlocker = 'has-document' | 'busy' | 'composing' | 'workspace-busy'
  | 'cleanup-pending' | 'review-required' | 'interruption-busy' | 'interruption-review';

/** Gates both the dialog's check button and the flow's runtime checks. */
export function interruptionBlocker(
  state: WorkspaceSnapshot | null,
  options: Readonly<{ busy: boolean; composing: boolean }>,
): InterruptionBlocker | null {
  if (!state) return 'workspace-busy';
  if (state.current) return 'has-document';
  if (options.busy) return 'busy';
  if (options.composing) return 'composing';
  if (state.phase !== 'idle') return 'workspace-busy';
  if (state.cleanupPending) return 'cleanup-pending';
  if (state.lastSave?.requiresReview || state.lastDeparture?.requiresReview) return 'review-required';
  const interruption = state.desktop?.interruption;
  if (interruption && interruption.phase !== 'idle') return 'interruption-busy';
  if (interruption?.requiresReview) return 'interruption-review';
  return null;
}

export function interruptionBlockerText(blocker: InterruptionBlocker): string {
  switch (blocker) {
    case 'has-document': return '当前已打开文档；请重启应用后，在打开文档前检查。当前文档与修改保持不变。';
    case 'busy': return '另一个操作正在进行，请稍候。';
    case 'composing': return '正在组词，请先完成当前输入。';
    case 'workspace-busy': return '工作区正忙，请稍候再检查。';
    case 'cleanup-pending': return '有待清理的临时文件，暂不能检查。';
    case 'review-required': return '有等待复核的保存或退出记录，暂不能检查。';
    case 'interruption-busy': return '中断检查正在进行，请稍候。';
    case 'interruption-review': return '有等待人工检查的中断处理结果；请保留当前窗口与记录，暂不能发起新检查。';
  }
}

/** Readable text for the Main-owned phase; idle renders nothing. */
export function interruptionPhaseText(phase: InterruptionState['phase']): string | null {
  switch (phase) {
    case 'checking': return '正在核验中断记录，随后需要在系统对话框中重新选择原 HTML 文件…';
    case 'reviewing': return '请在系统对话框中查看详情并选择；确认前不会修改任何文件。';
    case 'resolving': return '正在按确认处理，请勿关闭窗口…';
    case 'idle': return null;
  }
}

export type InterruptionResultView = Readonly<{
  tone: 'info' | 'ok' | 'warn' | 'error';
  text: string;
  detail: string | null;
  code: string | null;
  /** unknown / requiresReview never offer a direct retry. */
  canCheckAgain: boolean;
}>;

/**
 * Result area for the dialog, derived only from the Main-published
 * interruption state. Natural-Chinese distinctions per observation; nothing
 * here claims a past save succeeded or that newer edits are durable.
 */
export function interruptionResultView(state: InterruptionState | null): InterruptionResultView | null {
  const result = state?.result;
  if (!state || !result) return null;
  const summary = state.summary;
  if (state.requiresReview || result.status === 'unknown') {
    if (result.status === 'unknown') {
      return { tone: 'error', text: '处理结果未知：记录可能已更新，也可能未更新。相关证据与当前窗口已保留，等待人工检查。',
        detail: '请勿重试或强制退出；重试也无法撤销已开始的处理。', code: result.code, canCheckAgain: false };
    }
    if (result.status === 'resolved') {
      return { tone: 'warn', text: '处理已完成，但收尾核验有警告。相关证据与当前窗口已保留，等待人工检查。',
        detail: '请勿重复操作或强制退出。', code: result.code, canCheckAgain: false };
    }
    return { tone: 'warn', text: '本次检查留下了需要人工检查的状态，相关记录与证据已保留。',
      detail: '请勿重试或强制退出。', code: result.code, canCheckAgain: false };
  }
  switch (result.status) {
    case 'cancelled':
      return { tone: 'info', text: '已取消检查，未修改任何文件或记录。', detail: null, code: null, canCheckAgain: true };
    case 'unavailable':
      return { tone: 'info', text: '未发现当前入口可处理的中断记录。',
        detail: '这仅表示没有匹配的中断证据，不代表所有历史记录或文件都健康。', code: result.code, canCheckAgain: true };
    case 'failed':
      return { tone: 'error', text: '检查未完成，相关记录与证据已保留，未做修改。',
        detail: '可以重新发起检查；若反复失败，请保留窗口以便排查。', code: result.code, canCheckAgain: true };
    case 'resolved': {
      if (result.code !== null) {
        return { tone: 'warn', text: '处理已完成，但收尾核验有警告，相关证据已保留。',
          detail: '请勿重复操作。', code: result.code, canCheckAgain: false };
      }
      if (summary?.kind === 'save') {
        switch (summary.observed) {
          case 'baseline-matches':
            return { tone: 'ok', text: `检查完成：当前文件仍是上次保存前的版本，中断的保存没有写入；已保留当前文件并移除旧的中断标记。`,
              detail: '这不代表上次保存成功。如需恢复之前的修改，可之后使用“恢复草稿记录”流程，以重新核验的可用记录为准。', code: null, canCheckAgain: true };
          case 'committed-matches':
            return { tone: 'ok', text: '检查完成：完整的已提交证据与当前文件一致，上次修改已在文件中；已移除旧的中断标记。',
              detail: null, code: null, canCheckAgain: true };
          case 'candidate-on-disk':
            return { tone: 'ok', text: '检查完成：已确认保留当前文件并移除旧的中断标记。',
              detail: '磁盘内容来自上次准备写入的候选；这不代表上次保存成功，旧草稿不会被重放。', code: null, canCheckAgain: true };
          case 'conflict':
            return { tone: 'ok', text: '检查完成：已确认保留当前文件并移除旧的中断标记。',
              detail: '当前文件与保存前版本不一致，可能被其他程序修改；这不代表上次保存成功，旧草稿不会被重放。', code: null, canCheckAgain: true };
        }
      }
      if (summary?.kind === 'compaction') {
        return { tone: 'ok', text: `清理完成：${summary.obsoleteCount} 个已被取代的旧记录已移除，保留了两份最新完整点、其他会话与全部备份。`,
          detail: '清理成功不等于新修改已持久化，HTML 文件未被修改。', code: null, canCheckAgain: true };
      }
      return { tone: 'ok', text: '检查完成，旧的中断标记已移除。', detail: null, code: null, canCheckAgain: true };
    }
  }
}

function describeInspectError(code: string | null): string {
  switch (code) {
    case 'INTERRUPTION_BUSY': return '另一个检查或操作正在进行，请稍候。';
    case 'INTERRUPTION_REVIEW_REQUIRED': return '有等待人工检查的中断记录，暂不能发起新检查。';
    case 'INTERRUPTION_RESTART_REQUIRED': return '已打开文档，无法检查；请重启后，在打开文档前检查。';
    case 'INTERRUPTION_UNAVAILABLE': return '中断检查当前不可用。';
    case 'INTERRUPTION_NOT_FOUND': return '未发现当前入口可处理的中断记录。';
    case 'INTERRUPTION_UNCLASSIFIED': return '中断记录无法识别，未做修改；请保留窗口以便排查。';
    case 'STALE_WORKSPACE': return '工作区状态已变化，本次检查未执行。';
    default: return describeCode(code);
  }
}

export type InterruptionCheckDeps = Readonly<{
  getState: () => WorkspaceSnapshot | null;
  isComposing: () => boolean;
  /** guardFlush-style drain of the real input owner window; false = aborted. */
  flush: () => Promise<boolean>;
  /** The single renderer command; resolves when Main finished handling it. */
  inspect: (stateRevision: number) => Promise<WorkspaceResult>;
  /** Errors stay inside the originating dialog; nothing here is a toast. */
  onError: (text: string) => void;
}>;

/**
 * Start one interruption check. The nullable current identity (always null
 * here: a document of any kind blocks the check) is pinned before the input
 * owner is drained; after draining, the identity (null ⇄ nonnull), phase,
 * composing, cleanup, save/departure review flags and the maintenance gate are
 * rechecked and only the LATEST workspace revision is sent. A document that
 * appeared meanwhile cancels the check and nothing is delivered. The result
 * promise is only a transport ack: ok never closes the dialog or claims a
 * repair — the displayed outcome is Main's onState interruption.result.
 */
export async function runInterruptionCheck(deps: InterruptionCheckDeps): Promise<void> {
  const start = deps.getState();
  if (!start) return;
  const startBlocker = interruptionBlocker(start, { busy: false, composing: deps.isComposing() });
  if (startBlocker) {
    deps.onError(`无法检查：${interruptionBlockerText(startBlocker)}`);
    return;
  }
  const documentId = start.current?.id ?? null;
  let flushed: boolean;
  try {
    flushed = await deps.flush();
  } catch {
    deps.onError('检查前需要先完成当前输入；可能正在组词或投递失败，请检查校稿栏。');
    return;
  }
  if (!flushed) return; // the flush path already explained the failure
  const latest = deps.getState();
  if (!latest) return;
  if ((latest.current?.id ?? null) !== documentId) {
    deps.onError('文档状态已变化，本次检查已取消；请重新发起。');
    return;
  }
  const lateBlocker = interruptionBlocker(latest, { busy: false, composing: deps.isComposing() });
  if (lateBlocker) {
    deps.onError(`无法检查：${interruptionBlockerText(lateBlocker)}`);
    return;
  }
  let result: WorkspaceResult;
  try {
    result = await deps.inspect(latest.stateRevision);
  } catch {
    deps.onError(describeCode('EDITOR_DISCONNECTED'));
    return;
  }
  // ok only means the command was handled; the check/repair outcome is the
  // Main-published interruption.result, never this reply. Keep the dialog.
  if (result.ok) return;
  deps.onError(describeInspectError(result.code));
}

/**
 * Synchronous lifecycle binding for one InterruptionDialog opening, mirroring
 * the recovery dialog: the action latch is claimed synchronously inside the
 * acquired busy guard, before the first await, so a same-event-loop
 * Escape/close or menu reopen can never hide or reset an accepted check even
 * before the locked dialog re-renders. dispose() runs on unmount and
 * invalidates every outstanding generation, so a late result can never touch
 * a successor dialog.
 */
export class InterruptionDialogLifecycle {
  private generation = 0;
  private latched = false;

  /** Generation of the current opening; capture it before starting an action. */
  current(): number {
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  /** Genuinely new opening; refused while an accepted action is in flight. */
  open(): number | null {
    if (this.latched) return null;
    this.generation += 1;
    return this.generation;
  }

  /** User close; refused while an accepted action is in flight. */
  close(): boolean {
    if (this.latched) return false;
    this.generation += 1;
    return true;
  }

  /** Claim the action latch synchronously, before the first await. */
  acquire(): boolean {
    if (this.latched) return false;
    this.latched = true;
    return true;
  }

  /** Settle the latch once the action finishes (finally). */
  release(): void {
    this.latched = false;
  }

  /** Unmount: every outstanding generation and latch is dead. */
  dispose(): void {
    this.generation += 1;
    this.latched = false;
  }
}
