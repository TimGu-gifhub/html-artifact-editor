import { useSyncExternalStore } from 'react';
import type { WorkspaceSnapshot } from '../contracts/workspace.ts';

type Waiter = Readonly<{
  pred: (state: WorkspaceSnapshot) => boolean;
  resolve: (state: WorkspaceSnapshot | null) => void;
  timer: ReturnType<typeof setTimeout>;
}>;

// One window-scoped store over the trusted preload transport. The preload
// already rejects stale replies, but a request result can re-publish the same
// snapshot object next to an onState push; accept() therefore dedupes by
// reference and revisions so views never re-emit identical state.
export class WorkspaceStore {
  private listeners = new Set<() => void>();
  private waiters = new Set<Waiter>();
  private started = false;
  state: WorkspaceSnapshot | null = null;
  readError: string | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    const api = window.haeWorkspace;
    if (!api) {
      this.readError = 'MISSING_WORKSPACE_API';
      return;
    }
    api.onState(state => this.accept(state));
    void api.read().then(result => {
      if (result.state) this.accept(result.state);
      if (!result.ok && !result.state) {
        this.readError = result.code;
        this.emit();
      }
    }).catch(() => {
      this.readError = 'EDITOR_DISCONNECTED';
      this.emit();
    });
  }

  accept(state: WorkspaceSnapshot): void {
    const previous = this.state;
    if (previous) {
      if (state === previous) return;
      if (state.stateRevision < previous.stateRevision) return;
      if (state.stateRevision === previous.stateRevision
        && (state.desktop?.revision ?? 0) <= (previous.desktop?.revision ?? 0)) return;
    }
    this.state = state;
    for (const waiter of [...this.waiters]) {
      if (waiter.pred(state)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(state);
      }
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* A view callback cannot break the store. */ }
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getState = (): WorkspaceSnapshot | null => this.state;

  waitFor(pred: (state: WorkspaceSnapshot) => boolean, timeoutMs: number): Promise<WorkspaceSnapshot | null> {
    if (this.state && pred(this.state)) return Promise.resolve(this.state);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      const waiter: Waiter = { pred, resolve, timer };
      this.waiters.add(waiter);
    });
  }
}

export const workspaceStore = new WorkspaceStore();

export function useWorkspaceState(): WorkspaceSnapshot | null {
  workspaceStore.start();
  return useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getState);
}
