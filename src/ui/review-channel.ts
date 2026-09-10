import { useSyncExternalStore } from 'react';
import type { DesktopCommand } from '../contracts/desktop.ts';
import type { WorkspaceSnapshot } from '../contracts/workspace.ts';
import type { WorkspaceResult } from '../contracts/workspace-editor.ts';
import { workspaceStore } from './store.ts';
import { describeCode } from './util.ts';

type GetState = () => WorkspaceSnapshot | null;
type RequestFn = (command: DesktopCommand) => Promise<WorkspaceResult>;

export type ReviewStatus = Readonly<{ pending: boolean; error: string | null; errorSeq: number }>;

/**
 * Serialized, coalesced review-marker channel. Checkboxes express the full
 * desired set for the exact current candidate; rapid clicks update local
 * intent and only the latest set is sent after the in-flight request
 * finishes. A rejected request stops the chain and surfaces the error — it
 * never silently overwrites server state.
 */
export class ReviewChannel {
  private readonly getState: GetState;
  private readonly request: RequestFn;
  private desired: Set<string> | null = null;
  /** Binding (documentId:draftRevision:candidateHash) the desired set belongs to. */
  private desiredKey: string | null = null;
  private inflight = false;
  private sentKey: string | null = null;
  private candidateKey: string | null = null;
  private status: ReviewStatus = Object.freeze({ pending: false, error: null, errorSeq: 0 });
  private readonly listeners = new Set<() => void>();

  constructor(getState: GetState, request: RequestFn) {
    this.getState = getState;
    this.request = request;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getStatus = (): ReviewStatus => this.status;

  /** The set the UI should display: local intent while pending, else server. */
  currentReviewed(serverReviewed: readonly string[]): readonly string[] {
    return this.desired ? [...this.desired] : serverReviewed;
  }

  /** Forget local intent when the document or candidate changes. An
   *  interactive (readonly) document has a null input and therefore no
   *  binding: no intent may be collected or delivered for it. */
  private bindingOf(current: NonNullable<WorkspaceSnapshot['current']> | null): string | null {
    return current?.input ? `${current.id}:${current.input.draftRevision}:${current.input.candidateHash}` : null;
  }

  sync(): void {
    const key = this.bindingOf(this.getState()?.current ?? null);
    if (key !== this.candidateKey) {
      this.candidateKey = key;
      this.desired = null;
      this.desiredKey = null;
      this.sentKey = null;
    }
  }

  toggle(nodeId: string, checked: boolean): void {
    // 采集意图前同步当前绑定：旧文档/旧候选的待发意图不得带进新绑定。
    this.sync();
    const state = this.getState();
    if (!state?.current?.input) return;
    const base = this.desired ?? new Set(state.desktop?.reviewed ?? []);
    if (checked) base.add(nodeId);
    else base.delete(nodeId);
    this.desired = base;
    this.desiredKey = this.candidateKey;
    void this.drive();
  }

  toggleAll(checked: boolean): void {
    this.sync();
    const current = this.getState()?.current;
    if (!current?.input) return;
    this.desired = new Set(checked ? current.input.changes.map(change => change.nodeId) : []);
    this.desiredKey = this.candidateKey;
    void this.drive();
  }

  private setStatus(pending: boolean, error: string | null): void {
    this.status = {
      pending, error,
      errorSeq: error ? this.status.errorSeq + 1 : this.status.errorSeq,
    };
    for (const listener of this.listeners) {
      try { listener(); } catch { /* A view callback cannot break review. */ }
    }
  }

  private async drive(): Promise<void> {
    if (this.inflight || !this.desired) return;
    this.inflight = true;
    this.setStatus(true, null);
    try {
      while (this.desired) {
        const state = this.getState();
        const current = state?.current;
        const input = current?.input ?? null;
        if (!state || !current || !input) { this.desired = null; this.desiredKey = null; break; }
        const binding = this.bindingOf(current);
        if (this.desiredKey !== binding) {
          // 意图采集自旧文档/旧候选：丢弃而不是投递给当前绑定。
          this.desired = null;
          this.desiredKey = null;
          break;
        }
        const valid = new Set(input.changes.map(change => change.nodeId));
        const nodeIds = [...this.desired].filter(id => valid.has(id)).sort();
        const key = `${binding}:${nodeIds.join(',')}`;
        if (key === this.sentKey) { this.desired = null; this.desiredKey = null; break; }
        let result: WorkspaceResult | null = null;
        try {
          result = await this.request({
            kind: 'review', documentId: current.id,
            draftRevision: input.draftRevision, candidateHash: input.candidateHash,
            nodeIds,
          });
        } catch { result = null; }
        if (this.bindingOf(this.getState()?.current ?? null) !== binding) {
          // 这是旧绑定的迟到回复：不得清除新文档的意图，也不得为新文档记录
          // sentKey；新一轮循环按最新绑定重新判定。
          continue;
        }
        if (!result || !result.ok) {
          // Stop: keep server truth, surface the failure, never auto-retry.
          this.desired = null;
          this.desiredKey = null;
          this.sentKey = null;
          this.setStatus(false, describeCode(result?.code ?? 'EDITOR_DISCONNECTED'));
          return;
        }
        this.sentKey = key;
        if (this.desired && this.desiredKey === binding
          && [...this.desired].filter(id => valid.has(id)).sort().join(',') === nodeIds.join(',')) {
          this.desired = null;
          this.desiredKey = null;
        }
      }
    } finally {
      this.inflight = false;
      this.setStatus(false, this.status.error);
    }
  }
}

export const reviewChannel = new ReviewChannel(
  () => workspaceStore.getState(),
  command => {
    const desktop = window.haeDesktop;
    if (!desktop) return Promise.resolve({ ok: false, code: 'MISSING_DESKTOP_API', state: null, documentId: null, copy: null, outcome: null });
    return desktop.request(command);
  },
);

export function useReviewStatus(): ReviewStatus {
  return useSyncExternalStore(reviewChannel.subscribe, reviewChannel.getStatus);
}

export function requestReview(nodeId: string, checked: boolean): void {
  reviewChannel.toggle(nodeId, checked);
}

export function requestReviewAll(checked: boolean): void {
  reviewChannel.toggleAll(checked);
}
