import { useSyncExternalStore } from 'react';
import type { DocumentCommand, WorkspaceResult } from '../contracts/workspace-editor.ts';
import type { InputSnapshot } from '../contracts/input.ts';
import type { MappingSelection } from '../contracts/mapping.ts';

export const AUTO_APPLY_MS = 250;
export const MAX_INPUT_LENGTH = 128 * 1024;
/** src/core/patch/encoding.ts 的单段文字补丁上限：规范化后 UTF-8 64 KiB。 */
export const MAX_TEXT_BYTES = 64 * 1024;
const FLUSH_TIMEOUT_MS = 20000;

const NUL = String.fromCharCode(0);
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

export type LiveInputError = Readonly<{ message: string; detail: string }>;

export type LiveInputView = Readonly<{
  phase: 'idle' | 'beginning' | 'active' | 'failed';
  nodeId: string | null;
  localText: string;
  appliedText: string;
  /** 文件基线：changes 中的原文，或编辑开始时的文本。 */
  beginText: string;
  composing: boolean;
  busy: boolean;
  applying: boolean;
  /** close/dock/save flush acknowledged round in progress; textarea must be quiesced. */
  flushing: boolean;
  /** 目标 resolve 已开始：旧输入禁用，等待会话切换结论。 */
  resolving: boolean;
  dirty: boolean;
  canRestore: boolean;
  intentPending: boolean;
  error: LiveInputError | null;
}>;

type EditFn = (documentId: string, value: DocumentCommand) => Promise<WorkspaceResult>;
type SnapshotSource = () => Readonly<{ documentId: string | null; input: InputSnapshot | null }>;

const normalize = (text: string): string => text.replace(/\r\n?/g, '\n');

const utf8 = new TextEncoder();

export function validateInputText(text: string): string | null {
  if (text.includes(NUL)) return '文本包含 NUL 控制字符，无法写入 HTML。请删除不可见控制字符后重试。';
  if (LONE_SURROGATE.test(text)) return '文本包含不完整的 Unicode 字符（半个代理对），无法写入。请删除后重新输入。';
  if (text.length > MAX_INPUT_LENGTH) return `文本长度为 ${text.length} 字符，超过 128K 上限（${MAX_INPUT_LENGTH}）。请缩短后再试。`;
  const bytes = utf8.encode(normalize(text)).length;
  if (bytes > MAX_TEXT_BYTES) {
    return `文本按 UTF-8 编码后为 ${bytes} 字节，超过单段文字 64 KiB 上限（${MAX_TEXT_BYTES} 字节）；中文每字约 3 字节、emoji 约 4 字节。请缩短后再试。`;
  }
  return null;
}

const idleView: LiveInputView = Object.freeze({
  phase: 'idle', nodeId: null, localText: '', appliedText: '', beginText: '',
  composing: false, busy: false, applying: false, flushing: false, resolving: false, dirty: false,
  canRestore: false, intentPending: false, error: null,
});

/**
 * Strictly serial live-input controller for one proofreading panel.
 *
 * - Only the owner window sends begin/apply/resolve (setOwner).
 * - Every send re-checks the (documentId, editToken, nodeId) binding against
 *   the latest Main snapshot; a document/selection switch or teardown can
 *   never receive stale input.
 * - Local text is the textarea source of truth: late snapshots and stale
 *   replies never overwrite newer local input.
 * - Composition state is transmitted to Main as change(composing=true)
 *   without Apply; both local and Main composing block apply/resolve/flush.
 */
export class LiveInputController {
  private readonly editFn: EditFn;
  private readonly source: SnapshotSource;
  private readonly listeners = new Set<() => void>();

  private owner = false;
  private disposed = false;
  private generation = 0;
  private beginning = false;
  private failed: LiveInputError | null = null;
  private attemptedSelection: string | null = null;

  private documentId: string | null = null;
  private editToken: string | null = null;
  private nodeId: string | null = null;
  private mainRevision = 0;

  private localText = '';
  private appliedText = '';
  private beginText = '';
  private mainText = '';
  private composing = false;
  private composingSource: 'local' | 'adopted' | null = null;
  private validationError: string | null = null;

  private inflight = false;
  private inflightApply = false;
  private escapeAfterApply = false;
  /** localText at the moment Escape superseded an in-flight Apply. */
  private escapeMark: string | null = null;
  private resolving = false;
  private buffered: string | null = null;
  private wantApply = false;
  private applyTimer: ReturnType<typeof setTimeout> | null = null;

  private intentPending = false;
  private intentHandled = 0;

  private flushing = false;
  private flushWaiters = new Set<{ resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

  private view: LiveInputView = idleView;

  constructor(editFn: EditFn, source: SnapshotSource) {
    this.editFn = editFn;
    this.source = source;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getView = (): LiveInputView => this.view;

  setOwner(owner: boolean): void {
    this.owner = owner;
  }

  isComposing(): boolean {
    return this.composing;
  }

  /** True while a session is bound or a begin is in flight (flush must wait). */
  hasSessionOrPending(): boolean {
    return this.editToken !== null || this.beginning;
  }

  dispose(): void {
    this.disposed = true;
    this.owner = false;
    this.generation++;
    this.clearTimer();
    this.resolveFlush(false);
    this.listeners.clear();
  }

  /** File baseline for 还原：the node's oldText in the current changes. */
  private baselineFor(input: InputSnapshot, nodeId: string, fallback: string): string {
    return input.changes.find(change => change.nodeId === nodeId)?.oldText ?? fallback;
  }

  /**
   * 草稿冻结（原文件 Save unknown/需审查、Preview Apply 或历史结果未确认、文档
   * 关闭）：草稿不再接受任何修改。冻结期间本地不发送 begin/change/apply/resolve
   * 等修改请求，也不清空 token、文本、缓冲、失败或组词状态；正常 preparing/
   * applying 持久化阶段不是冻结，实时输入的缓冲行为保持不变。
   */
  private draftIsFrozen(): boolean {
    const { input } = this.source();
    return input !== null && (input.draftPhase === 'uncertain' || input.draftPhase === 'closed');
  }

  /** Observe the latest Main snapshot. Called on every workspace state change. */
  sync(): void {
    if (this.disposed) return;
    const { documentId, input } = this.source();
    if (!this.editToken) {
      // Adopt an already-active session (dock/float handoff or window reload).
      if (this.owner && !this.beginning && !this.failed && documentId && input?.input) {
        const active = input.input;
        this.documentId = documentId;
        this.editToken = active.editToken;
        this.nodeId = active.nodeId;
        this.mainRevision = active.revision;
        this.localText = active.text;
        this.mainText = active.text;
        this.appliedText = active.appliedText;
        this.beginText = this.baselineFor(input, active.nodeId, active.appliedText);
        this.composing = active.composing;
        this.composingSource = active.composing ? 'adopted' : null;
        this.intentHandled = input.intent?.sequence ?? 0;
        this.generation++;
        this.emit();
      }
      return;
    }
    const active = documentId === this.documentId && input?.input
      && input.input.editToken === this.editToken && input.input.nodeId === this.nodeId
      ? input.input : null;
    if (!active) {
      this.clearTimer();
      this.wantApply = false;
      this.buffered = null;
      if (this.resolving) {
        // Our own resolve was accepted; Main published the ended session before
        // the invoke reply arrived. This is a confirmed drain, not a loss.
        this.resolving = false;
        this.resetSession();
        this.resolveFlush(true);
        this.emit();
        return;
      }
      const unsaved = normalize(this.localText) !== normalize(this.appliedText);
      if (unsaved) {
        this.failed = {
          message: '编辑会话已结束或失效，你未预览的修改没有投递到页面。',
          detail: '本地保留的文字见输入框，可复制保存；也可用“另存草稿”保留证据。重新选择文字可开始新的编辑。',
        };
        this.resolveFlush(false);
      } else {
        this.resetSession();
        this.resolveFlush(true);
      }
      this.emit();
      return;
    }
    this.mainRevision = Math.max(this.mainRevision, active.revision);
    if (active.appliedText !== this.appliedText) {
      // An external applied change (history undo/redo, restore). Adopt it only
      // when there is no newer local input to protect.
      if (this.buffered === null && normalize(this.localText) === normalize(this.appliedText)) {
        this.localText = active.appliedText;
      }
      this.appliedText = active.appliedText;
      this.beginText = this.baselineFor(input!, active.nodeId, this.beginText);
    }
    this.mainText = active.text;
    const intent = input?.intent ?? null;
    if (this.owner && intent && intent.sequence > this.intentHandled) {
      this.intentPending = true;
    }
    this.pump();
    this.maybeFlush();
    this.emit();
  }

  /** Begin editing the selection Main published. Idempotent per selection key. */
  async begin(selectionKey: string, selection: MappingSelection, draftRevision: number): Promise<void> {
    if (!this.owner || this.disposed || this.editToken || this.beginning) return;
    if (this.attemptedSelection === selectionKey) return;
    const { documentId } = this.source();
    if (!documentId) return;
    if (this.draftIsFrozen()) {
      // 冻结草稿不接受新会话；记住已尝试，避免每次快照更新重复发起。
      this.attemptedSelection = selectionKey;
      return;
    }
    this.beginning = true;
    this.failed = null;
    this.emit();
    const generation = this.generation;
    let result: WorkspaceResult;
    try {
      result = await this.editFn(documentId, { kind: 'begin', value: { selection, draftRevision } });
    } catch {
      result = { ok: false, code: 'EDITOR_DISCONNECTED', state: null, documentId, copy: null, outcome: null };
    }
    if (this.disposed) return;
    this.beginning = false;
    if (this.generation !== generation || this.editToken) {
      // 回复在途期间面板已绑定更新的会话：这条 begin 回复已失效。
      this.pump();
      this.maybeFlush();
      this.emit();
      return;
    }
    const snap = this.source();
    const active = snap.documentId === documentId && snap.input?.input
      && snap.input.input.nodeId === selection.nodeId ? snap.input.input : null;
    if (result.ok && active) {
      this.documentId = documentId;
      this.editToken = active.editToken;
      this.nodeId = active.nodeId;
      this.mainRevision = active.revision;
      this.localText = active.text;
      this.mainText = active.text;
      this.appliedText = active.appliedText;
      this.beginText = snap.input ? this.baselineFor(snap.input, active.nodeId, active.text) : active.text;
      this.attemptedSelection = null;
      this.intentHandled = snap.input?.intent?.sequence ?? 0;
      this.generation++;
    } else {
      this.attemptedSelection = selectionKey;
      this.failed = {
        message: '无法开始编辑这段文字。',
        detail: result.code ? `错误代码：${result.code}` : '选择已失效，请在预览中重新点击这段文字。',
      };
      this.resolveFlush(false);
    }
    this.pump();
    this.maybeFlush();
    this.emit();
  }

  /** Manual retry after a failed begin or a rejected pipeline. */
  retry(): void {
    if (this.beginning || this.disposed || this.draftIsFrozen()) return;
    if (this.editToken) {
      if (this.validationError) return;
      this.failed = null;
      this.buffered = normalize(this.localText);
      this.scheduleApply();
      this.pump();
    } else {
      // Allow the next begin attempt for the current selection.
      this.failed = null;
      this.attemptedSelection = null;
    }
    this.emit();
  }

  /**
   * Explicitly discard preserved local text after a failure: clears the
   * binding and generation so a fresh selection can begin; never writes old
   * text into a new document.
   */
  discardFailed(): void {
    if (!this.failed || this.disposed) return;
    this.failed = null;
    this.validationError = null;
    if (!this.sessionInput()) {
      this.resetSession();
    }
    this.emit();
  }

  onChange(text: string): void {
    // 冻结时 readOnly textarea 本不应产生输入事件；万一到达也整体忽略，
    // 保留原 token、文本、缓冲、失败与组词状态。
    if (this.disposed || this.resolving || this.draftIsFrozen()) return;
    this.localText = text;
    this.validationError = validateInputText(text);
    if (this.composingSource === 'adopted') {
      // A stale Main composing flag from before a handoff; real typing
      // supersedes it. Local composition events set 'local' instead.
      this.composing = false;
      this.composingSource = null;
    }
    if (!this.editToken || this.failed) { this.emit(); return; }
    if (this.validationError) { this.emit(); return; }
    // Even during a flush the latest local text must be delivered; the panel
    // quiesces the textarea visually, the controller still drains honestly.
    this.buffered = normalize(text);
    if (!this.composing) this.scheduleApply();
    this.pump();
    this.emit();
  }

  onCompositionStart(): void {
    if (this.disposed || this.resolving || this.draftIsFrozen()) return;
    this.composing = true;
    this.composingSource = 'local';
    this.clearTimer();
    // 组词开始本身就串行通知 Main（composing=true），不等第一个字符事件；
    // 这样并发的关闭/保存请求总能看到组词状态。文本未变也发送。
    if (this.editToken && !this.failed && !this.validationError) {
      if (this.buffered === null) this.buffered = normalize(this.localText);
      this.pump();
    }
    this.emit();
  }

  onCompositionEnd(text: string): void {
    if (this.disposed || this.resolving || this.draftIsFrozen()) return;
    this.composing = false;
    this.composingSource = null;
    this.localText = text;
    this.validationError = validateInputText(text);
    if (this.editToken && !this.failed && !this.validationError) {
      this.buffered = normalize(text);
      this.scheduleApply();
    }
    this.pump();
    this.emit();
  }

  /**
   * Escape cancels only input Main has not yet applied: unsent buffered text
   * and unapplied change-level text are withdrawn towards appliedText. An
   * accepted or in-flight Apply is never undone implicitly; input typed after
   * Escape supersedes the cancellation intent and is delivered normally.
   */
  escape(): boolean {
    // 冻结时 Escape 不得恢复/撤回任何输入；只读保留的文字仍可选择复制。
    if (this.disposed || this.resolving || this.composing || !this.editToken || this.failed
      || this.draftIsFrozen()) return false;
    if (this.inflightApply) {
      this.clearTimer();
      this.wantApply = false;
      this.buffered = null;
      this.escapeAfterApply = true;
      this.escapeMark = this.localText;
      this.emit();
      return true;
    }
    const unapplied = this.buffered !== null
      || normalize(this.localText) !== normalize(this.appliedText)
      || normalize(this.mainText) !== normalize(this.appliedText);
    if (!unapplied) return false;
    this.clearTimer();
    this.wantApply = false;
    this.validationError = null;
    this.localText = this.appliedText;
    if (normalize(this.mainText) !== normalize(this.appliedText) || this.buffered !== null) {
      this.buffered = normalize(this.appliedText);
    }
    this.pump();
    this.emit();
    return true;
  }

  /** 还原为文件原文：submit the file baseline as a new applied draft (undoable). */
  restoreParagraph(): void {
    if (this.disposed || this.resolving || !this.editToken || this.failed || this.beginning || this.composing
      || this.draftIsFrozen()) return;
    this.clearTimer();
    this.validationError = null;
    this.localText = this.beginText;
    this.buffered = normalize(this.beginText);
    this.wantApply = true;
    this.pump();
    this.emit();
  }

  /**
   * Drain the pipeline: deliver the latest local text and apply it, then keep
   * the textarea quiesced until the acknowledged round ends. Resolves false
   * immediately while composing or after a failure; never retries on its own.
   */
  flush(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.composing || this.failed || this.validationError) return Promise.resolve(false);
    if (!this.editToken && !this.beginning) return Promise.resolve(true);
    if (this.draftIsFrozen()) {
      // 冻结期间不能发送任何修改，也不清空本地状态换取成功：只有干净且已完全
      // 应用的 owner 直接确认排空（供 Main 的独占副本另存等独立事务判断），
      // 仍有未投递缓冲、未应用差异、组词或在途/失败状态的一律拒绝；关闭与归属
      // 切换是否放行仍由 Main 决定。
      return Promise.resolve(this.mainDrained()
        && normalize(this.localText) === normalize(this.appliedText));
    }
    this.flushing = true;
    this.emit();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.flushWaiters.delete(waiter);
        if (!this.flushWaiters.size) this.flushing = false;
        this.emit();
        resolve(false);
      }, FLUSH_TIMEOUT_MS);
      const waiter = { resolve, timer };
      this.flushWaiters.add(waiter);
      this.clearTimer();
      if (this.editToken) this.wantApply = true;
      this.pump();
      this.maybeFlush();
      this.emit();
    });
  }

  private scheduleApply(): void {
    this.clearTimer();
    this.applyTimer = setTimeout(() => {
      this.applyTimer = null;
      this.wantApply = true;
      this.pump();
      this.emit();
    }, AUTO_APPLY_MS);
  }

  private clearTimer(): void {
    if (this.applyTimer !== null) {
      clearTimeout(this.applyTimer);
      this.applyTimer = null;
    }
  }

  private sessionInput(): InputSnapshot | null {
    const { documentId, input } = this.source();
    if (!this.editToken || documentId !== this.documentId || !input?.input) return null;
    if (input.input.editToken !== this.editToken || input.input.nodeId !== this.nodeId) return null;
    return input;
  }

  private pump(): void {
    if (this.disposed || this.inflight || !this.owner || this.failed) return;
    const input = this.sessionInput();
    if (!input) return;
    if (input.phase !== 'idle') return;
    if (input.draftPhase === 'uncertain' || input.draftPhase === 'closed') {
      // 草稿冻结：暂停一切自动变更——不发 change/apply，也不对 pending 的
      // 目标 intent 自动 resolve。缓冲、wantApply 与 intentPending 原样保留，
      // 等待明确的处置结果，绝不靠丢弃本地状态推进。
      return;
    }
    if (this.buffered !== null) {
      void this.sendChange();
      return;
    }
    if (this.composing) return;
    const mainDirty = normalize(this.mainText) !== normalize(this.appliedText);
    if (this.intentPending) {
      const intent = input.intent;
      if (!intent || intent.sequence <= this.intentHandled) {
        this.intentPending = false;
        this.emit();
        return;
      }
      // Consume the pending apply exactly once, then resolve the latest intent
      // only after the apply is confirmed by Main.
      this.wantApply = false;
      if (mainDirty) {
        if (input.canApply) void this.sendApply();
        return;
      }
      void this.sendResolve(intent.sequence);
      return;
    }
    if (this.wantApply) {
      if (!mainDirty) {
        this.wantApply = false;
        this.maybeFlush();
        this.emit();
      } else if (input.canApply) {
        this.wantApply = false;
        void this.sendApply();
      }
    }
  }

  private async sendChange(): Promise<void> {
    const text = this.buffered;
    if (text === null || !this.editToken || !this.documentId) return;
    this.buffered = null;
    const generation = this.generation;
    const token = this.editToken;
    const documentId = this.documentId;
    this.inflight = true;
    this.emit();
    const result = await this.call({ kind: 'change', value: {
      editToken: token, inputRevision: this.mainRevision + 1,
      newText: text, composing: this.composing,
    } });
    this.inflight = false;
    if (this.disposed) return;
    if (this.generation !== generation || this.editToken !== token || this.documentId !== documentId) {
      // 已失效回复：面板已绑定更新的会话，不得改动其状态；恢复泵送新会话。
      this.pump();
      this.maybeFlush();
      this.emit();
      return;
    }
    if (result.ok && this.sessionInput()) {
      this.mainText = text;
      const active = this.sessionInput()?.input;
      if (active) this.mainRevision = Math.max(this.mainRevision, active.revision);
    } else if (!result.ok && this.sessionInput()) {
      this.failed = {
        message: '修改未能送达预览，你的输入已保留在输入框中。',
        detail: result.code ? `错误代码：${result.code}` : '主进程未确认这次修改。',
      };
      this.resolveFlush(false);
    }
    this.pump();
    this.maybeFlush();
    this.emit();
  }

  private async sendApply(): Promise<void> {
    if (!this.editToken || !this.documentId) return;
    const generation = this.generation;
    const token = this.editToken;
    const documentId = this.documentId;
    this.inflight = true;
    this.inflightApply = true;
    this.emit();
    const result = await this.call({ kind: 'apply', value: {
      editToken: token, inputRevision: this.mainRevision,
    } });
    this.inflight = false;
    this.inflightApply = false;
    if (this.disposed) return;
    if (this.generation !== generation || this.editToken !== token || this.documentId !== documentId) {
      // 已失效回复：面板已绑定更新的会话，不得改动其状态。
      this.pump();
      this.maybeFlush();
      this.emit();
      return;
    }
    const active = this.sessionInput()?.input;
    if (result.ok && active) {
      this.mainRevision = Math.max(this.mainRevision, active.revision);
      this.appliedText = active.appliedText;
      this.mainText = active.text;
      if (this.escapeAfterApply) {
        this.escapeAfterApply = false;
        // Escape 之后又有了新输入（待发缓冲、校验中的文本或与 Escape 时不同
        // 的本地文本）：较新的输入取代取消意图，不得清掉或覆盖。
        const superseded = this.buffered !== null || this.validationError !== null
          || (this.escapeMark !== null && normalize(this.localText) !== normalize(this.escapeMark));
        this.escapeMark = null;
        if (!superseded) {
          // Escape during the accepted Apply: settle on the newly applied text,
          // discard only what was never sent.
          this.clearTimer();
          this.wantApply = false;
          this.buffered = null;
          this.localText = this.appliedText;
        }
      }
    } else if (!result.ok && this.sessionInput()) {
      this.escapeAfterApply = false;
      this.escapeMark = null;
      this.failed = {
        message: '预览更新失败，你的输入已保留在输入框中。',
        detail: result.code ? `错误代码：${result.code}` : '主进程未确认这次应用。',
      };
      this.resolveFlush(false);
    }
    this.pump();
    this.maybeFlush();
    this.emit();
  }

  private async sendResolve(intentSequence: number): Promise<void> {
    if (!this.editToken || !this.documentId) return;
    const generation = this.generation;
    const token = this.editToken;
    this.inflight = true;
    this.resolving = true;
    this.emit();
    const result = await this.call({ kind: 'resolve', value: {
      editToken: this.editToken, inputRevision: this.mainRevision,
      decision: 'apply', intentSequence,
    } });
    this.inflight = false;
    if (this.disposed) return;
    if (this.generation !== generation || this.editToken !== token) {
      // The session already transitioned (sync reconciled the accepted
      // resolve, or a newer session owns the panel). Never reset it here.
      return;
    }
    this.resolving = false;
    if (result.ok) {
      this.intentHandled = intentSequence;
      this.intentPending = false;
      this.resetSession();
      this.resolveFlush(true);
    } else if (this.sessionInput()) {
      this.intentPending = false;
      this.intentHandled = intentSequence;
      this.failed = {
        message: '切换到新选中的文字失败，当前输入已保留。',
        detail: result.code ? `错误代码：${result.code}` : '主进程未确认这次切换。',
      };
      this.resolveFlush(false);
    }
    this.emit();
  }

  private async call(value: DocumentCommand): Promise<WorkspaceResult> {
    try {
      return await this.editFn(this.documentId!, value);
    } catch {
      return { ok: false, code: 'EDITOR_DISCONNECTED', state: null, documentId: this.documentId, copy: null, outcome: null };
    }
  }

  private mainDrained(): boolean {
    return !this.beginning && !this.inflight && this.buffered === null && !this.wantApply
      && !this.composing && !this.failed && !this.validationError
      && normalize(this.mainText) === normalize(this.appliedText);
  }

  private maybeFlush(): void {
    if (!this.flushWaiters.size) return;
    if (this.editToken && !this.mainDrained()) return;
    if (this.beginning) return;
    this.resolveFlush(true);
  }

  private resolveFlush(ok: boolean): void {
    if (!this.flushWaiters.size) return;
    for (const waiter of [...this.flushWaiters]) {
      clearTimeout(waiter.timer);
      this.flushWaiters.delete(waiter);
      waiter.resolve(ok);
    }
    this.flushing = false;
    this.emit();
  }

  private resetSession(): void {
    this.editToken = null;
    this.nodeId = null;
    this.documentId = null;
    this.mainRevision = 0;
    this.localText = '';
    this.appliedText = '';
    this.beginText = '';
    this.mainText = '';
    this.buffered = null;
    this.wantApply = false;
    this.intentPending = false;
    this.validationError = null;
    this.composing = false;
    this.composingSource = null;
    this.escapeAfterApply = false;
    this.escapeMark = null;
    this.generation++;
    this.clearTimer();
  }

  private emit(): void {
    if (this.disposed) return;
    const dirty = this.buffered !== null
      || normalize(this.localText) !== normalize(this.appliedText)
      || (this.editToken !== null && normalize(this.mainText) !== normalize(this.appliedText));
    this.view = {
      phase: this.failed ? 'failed' : this.beginning ? 'beginning' : this.editToken ? 'active' : 'idle',
      nodeId: this.nodeId,
      localText: this.localText,
      appliedText: this.appliedText,
      beginText: this.beginText,
      composing: this.composing,
      busy: this.inflight,
      applying: this.inflightApply || this.wantApply,
      flushing: this.flushing,
      resolving: this.resolving,
      dirty,
      canRestore: this.editToken !== null && !this.failed && !this.composing && !this.flushing
        && normalize(this.localText) !== normalize(this.beginText),
      intentPending: this.intentPending,
      error: this.failed ?? (this.validationError ? { message: this.validationError, detail: '' } : null),
    };
    for (const listener of this.listeners) {
      try { listener(); } catch { /* A view callback cannot break input. */ }
    }
  }
}

export function useLiveInput(controller: LiveInputController): LiveInputView {
  return useSyncExternalStore(controller.subscribe, controller.getView);
}
