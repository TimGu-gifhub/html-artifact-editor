import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceSnapshot } from '../contracts/workspace.ts';
import type { PanelMode, PdfOptions } from '../contracts/desktop.ts';
import type { WorkspaceDiff } from '../contracts/source-diff.ts';
import type { BackupSummary, WorkspaceBackupCatalog } from '../contracts/backup.ts';
import type { WorkspaceRecoveryCatalog } from '../contracts/recovery.ts';
import type { WorkspaceResult } from '../contracts/workspace-editor.ts';
import { useWorkspaceState, workspaceStore } from './store.ts';
import { LiveInputController, useLiveInput } from './live-input.ts';
import { ensureInputFlushed } from './flush.ts';
import type { FlushDeps } from './flush.ts';
import { BusyGuard, entrySwitchBlocker, entrySwitchBlockerText, runEntrySwitch } from './entry-switch.ts';
import { modeSwitchBlockerText, modeSwitchTarget, runModeSwitch } from './mode-switch.ts';
import { loadRecoveryCatalog, RecoveryDialogLifecycle, runRecoveryRestore } from './recovery-flow.ts';
import type { RecoverySourceMode } from './recovery-flow.ts';
import { InterruptionDialogLifecycle, interruptionBlocker, interruptionGate, interruptionGateText, runInterruptionCheck } from './interruption-flow.ts';
import type { InterruptionGate } from './interruption-flow.ts';
import { classifySaveResult } from './save-result.ts';
import { EditorPanel } from './editor-panel.tsx';
import { ReviewPanel } from './review-panel.tsx';
import { reviewChannel, useReviewStatus } from './review-channel.ts';
import { BackupsDialog, PdfDialog, RecoveryDialog, ResourcesDialog, SaveDiffDialog } from './dialogs.tsx';
import { InterruptionDialog } from './interruption-dialog.tsx';
import { Dialog } from './dialog.tsx';
import type { SaveError } from './dialogs.tsx';
import { describeCode } from './util.ts';
import { IconDock, IconFloat, IconFolder, IconMenu, IconMode, IconOpen, IconPanelHide, IconPanelShow, IconPdf, IconRedo, IconSave, IconUndo } from './icons.tsx';

const desktopApi = () => window.haeDesktop ?? null;
const workspaceApi = () => window.haeWorkspace ?? null;

export function App() {
  const state = useWorkspaceState();
  if (!state) {
    return <div className="boot" role="status">正在连接工作区…</div>;
  }
  const role = state.desktop?.role ?? 'main';
  return role === 'editor' ? <EditorWindow state={state} /> : <MainWindow state={state} />;
}

/** One controller per window; only the owner window's controller sends input commands. */
function useController(state: WorkspaceSnapshot, owner: boolean): LiveInputController {
  const controller = useMemo(() => new LiveInputController(
    (documentId, value) => {
      const api = workspaceApi();
      if (!api) return Promise.resolve({ ok: false, code: 'MISSING_WORKSPACE_API', state: null, documentId, copy: null, outcome: null });
      return api.edit(documentId, value);
    },
    () => {
      const latest = workspaceStore.getState();
      return { documentId: latest?.current?.id ?? null, input: latest?.current?.input ?? null };
    },
  ), []);
  useEffect(() => {
    controller.setOwner(owner);
    controller.sync();
  }, [controller, state, owner]);
  useEffect(() => () => controller.dispose(), [controller]);
  return controller;
}

/** Observe Main's single-shot flush requests; each id is answered exactly once. */
function useFlushRequests(state: WorkspaceSnapshot, owner: boolean, controller: LiveInputController): void {
  const handled = useRef(new Set<string>());
  useEffect(() => {
    const flush = state.desktop?.flush ?? null;
    if (!flush || !owner || handled.current.has(flush.id)) return;
    handled.current.add(flush.id);
    void (async () => {
      const ok = await controller.flush();
      try {
        await desktopApi()?.request({ kind: 'flushed', id: flush.id, ready: ok });
      } catch { /* Main keeps the close/dock decision and evidence. */ }
    })();
  }, [state, owner, controller]);
}

/**
 * Before hide/dock/open/save/save-copy/PDF: drain the latest local input.
 * Owner windows drain through their own controller; non-owner windows ask
 * Main to route a flush to the owner window. Neither side may infer "no
 * pending input" from a Main snapshot. See src/ui/flush.ts.
 */
function flushWith(deps: FlushDeps): Promise<boolean> {
  const desktop = desktopApi();
  return ensureInputFlushed(deps, workspaceStore, desktop ? command => desktop.request(command) : null);
}

function usePreviewLayout(role: 'main' | 'editor', visible: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const lastRef = useRef('');
  useEffect(() => {
    if (role !== 'main') return;
    const el = ref.current;
    if (!el) return;
    lastRef.current = '';
    const send = () => {
      const rect = el.getBoundingClientRect();
      const clamp = (value: number) => Math.min(16384, Math.max(0, Math.round(value)));
      const x = clamp(rect.x);
      const y = clamp(rect.y);
      const width = clamp(rect.width);
      const height = clamp(rect.height);
      const shown = visible && width > 0 && height > 0;
      const key = `${x},${y},${width},${height},${shown}`;
      if (key === lastRef.current) return;
      lastRef.current = key;
      void desktopApi()?.request({ kind: 'layout', x, y, width, height, visible: shown }).catch(() => undefined);
    };
    const observer = new ResizeObserver(send);
    observer.observe(el);
    send();
    return () => observer.disconnect();
  }, [role, visible]);
  return ref;
}

function useNarrow(): boolean {
  const query = useMemo(() => window.matchMedia('(max-width: 1023px)'), []);
  const [narrow, setNarrow] = useState(query.matches);
  useEffect(() => {
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}

type Toast = Readonly<{ id: number; text: string; kind: 'info' | 'error' }>;

function useToast(): [Toast | null, (text: string, kind?: 'info' | 'error') => void] {
  const [toast, setToast] = useState<Toast | null>(null);
  const counter = useRef(0);
  const show = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    counter.current += 1;
    setToast({ id: counter.current, text, kind });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(current => current?.id === toast.id ? null : current), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  return [toast, show];
}

type DialogKind = 'diff' | 'pdf' | 'recovery' | 'backups' | 'resources' | 'interruption';

function MainWindow(props: Readonly<{ state: WorkspaceSnapshot }>) {
  const { state } = props;
  const current = state.current;
  const input = current?.input ?? null;
  // 脚本只读预览：Main 提供 mode=interactive、input=null、persistence=null。
  const readonly = current?.mode === 'interactive';
  const panel: PanelMode = state.desktop?.panel ?? 'docked';
  const owner = panel !== 'floating';
  const controlVisible = panel === 'docked';
  const controller = useController(state, owner);
  const inputView = useLiveInput(controller);
  useFlushRequests(state, owner, controller);
  const narrow = useNarrow();
  const [toast, showToast] = useToast();
  const reviewStatus = useReviewStatus();
  useEffect(() => { reviewChannel.sync(); }, [state]);
  useEffect(() => {
    if (reviewStatus.errorSeq > 0 && reviewStatus.error) {
      showToast(`复核勾选未被记录：${reviewStatus.error}`, 'error');
    }
  }, [reviewStatus.errorSeq, reviewStatus.error, showToast]);
  const effectiveReviewed = reviewChannel.currentReviewed(state.desktop?.reviewed ?? []);

  const [dialog, setDialogState] = useState<DialogKind | null>(null);
  // Synchronous mirror of the dialog state: late async results check it
  // without waiting for a render, so they never touch a replacement dialog.
  const dialogRef = useRef<DialogKind | null>(null);
  const setDialog = useCallback((next: DialogKind | null) => {
    dialogRef.current = next;
    setDialogState(next);
  }, []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (menuWrapRef.current && event.target instanceof Node && !menuWrapRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);
  const [beginNonce, setBeginNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [pdfOptions, setPdfOptions] = useState<PdfOptions>({ paper: 'A4', landscape: false, background: false });
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ loading: boolean; catalog: WorkspaceRecoveryCatalog | null; error: string | null; busySession: string | null }>({ loading: false, catalog: null, error: null, busySession: null });
  // Binds catalog/restore results to one RecoveryDialog opening: closing or
  // reopening bumps the generation, so late results can never touch the new
  // dialog, clear its busy state or resurrect a closed one. The synchronous
  // action latch covers the window before the locked dialog re-renders, and
  // unmounting invalidates every outstanding generation.
  const recoveryLife = useMemo(() => new RecoveryDialogLifecycle(), []);
  useEffect(() => () => recoveryLife.dispose(), [recoveryLife]);
  const [backups, setBackups] = useState<{ loading: boolean; catalog: WorkspaceBackupCatalog | null; error: string | null; busy: boolean }>({ loading: false, catalog: null, error: null, busy: false });
  // Same binding as the recovery dialog: the synchronous latch covers the
  // window before the locked dialog re-renders, generations bind late results
  // to one opening, and unmount invalidates everything in flight.
  const interruptionLife = useMemo(() => new InterruptionDialogLifecycle(), []);
  useEffect(() => () => interruptionLife.dispose(), [interruptionLife]);
  const [interruptionChecking, setInterruptionChecking] = useState(false);
  const [interruptionError, setInterruptionError] = useState<string | null>(null);

  const modalOpen = dialog !== null || (drawerOpen && narrow);
  const previewVisible = !!current && !modalOpen && !menuOpen;
  const previewRef = usePreviewLayout('main', previewVisible);

  useEffect(() => {
    if (!narrow && drawerOpen) setDrawerOpen(false);
  }, [narrow, drawerOpen]);

  // Begin editing the selection Main published (owner window with visible panel only).
  useEffect(() => {
    if (!controlVisible || !input || input.input || input.phase !== 'idle' || !input.selection) return;
    const reference = input.selection.reference;
    const key = `${reference.nodeId}:${reference.revision}:${reference.identity.preview.sessionId}:${reference.identity.preview.generation}`;
    void controller.begin(key, reference, input.draftRevision);
  }, [controlVisible, input, controller, beginNonce]);

  const onRetryBegin = useCallback(() => {
    controller.retry();
    setBeginNonce(value => value + 1);
  }, [controller]);

  const flushDeps: FlushDeps = useMemo(() => ({ owner, controller }), [owner, controller]);

  const guardFlush = useCallback(async (action: string): Promise<boolean> => {
    if (await flushWith(flushDeps)) return true;
    showToast(`${action}前需要先完成当前输入；可能正在组词或投递失败，请检查校稿栏。`, 'error');
    return false;
  }, [flushDeps, showToast]);

  const busyGuard = useMemo(() => new BusyGuard(), []);
  const runBusy = useCallback(async (task: () => Promise<void>) => {
    if (!busyGuard.tryAcquire()) return;
    setBusy(true);
    try { await task(); } finally { busyGuard.release(); setBusy(false); }
  }, [busyGuard]);

  // Maintenance gate: while Main is checking an interruption or the result
  // needs review, no other write/open/restore action may start from this
  // window (Main rejects them too). Read from the live store so callbacks and
  // keyboard handlers never go stale.
  const maintenanceGate = useCallback((): InterruptionGate | null => interruptionGate(workspaceStore.getState()), []);
  const blockedByMaintenance = useCallback((): boolean => {
    const gate = maintenanceGate();
    if (gate) showToast(interruptionGateText(gate), 'error');
    return gate !== null;
  }, [maintenanceGate, showToast]);

  const [switching, setSwitching] = useState(false);
  const onSwitchEntry = useCallback(() => {
    if (blockedByMaintenance()) return;
    void runBusy(async () => {
    setSwitching(true);
    try {
      await runEntrySwitch({
        getState: () => workspaceStore.getState(),
        isComposing: () => controller.isComposing(),
        flush: () => guardFlush('切换入口'),
        switchEntry: (documentId, stateRevision) => {
          const api = workspaceApi();
          if (!api) return Promise.resolve({ ok: false, code: 'MISSING_WORKSPACE_API', state: null, documentId, copy: null, outcome: null });
          return api.switchEntry(documentId, stateRevision);
        },
        showToast,
      });
    } finally { setSwitching(false); }
  });
  }, [runBusy, guardFlush, controller, showToast, blockedByMaintenance]);

  const [switchingMode, setSwitchingMode] = useState(false);
  // 模式切换：固定当前文档后先排空实际输入窗口，再用最新修订请求 Main。
  // Main 拥有草稿的取消/放弃/另存决定；这里不新建任何渲染进程侧的草稿路径。
  const onSwitchMode = useCallback(() => {
    if (blockedByMaintenance()) return;
    void runBusy(async () => {
    setSwitchingMode(true);
    try {
      await runModeSwitch({
        getState: () => workspaceStore.getState(),
        isComposing: () => controller.isComposing(),
        flush: () => guardFlush('切换模式'),
        switchMode: (documentId, stateRevision, mode) => {
          const api = workspaceApi();
          if (!api) return Promise.resolve({ ok: false, code: 'MISSING_WORKSPACE_API', state: null, documentId, copy: null, outcome: null });
          return api.switchMode(documentId, stateRevision, mode);
        },
        showToast,
      });
    } finally { setSwitchingMode(false); }
  });
  }, [runBusy, guardFlush, controller, showToast, blockedByMaintenance]);

  const onOpen = useCallback((directory: boolean) => void runBusy(async () => {
    if (blockedByMaintenance()) return;
    if (!(await guardFlush('打开'))) return;
    const latest = workspaceStore.getState();
    const api = workspaceApi();
    if (!latest || !api) return;
    const result = directory ? await api.openDirectory(latest.stateRevision) : await api.open(latest.stateRevision);
    if (!result.ok) showToast(describeCode(result.code), 'error');
  }), [runBusy, guardFlush, showToast, blockedByMaintenance]);

  const onHistory = useCallback((direction: 'undo' | 'redo') => void runBusy(async () => {
    if (blockedByMaintenance()) return;
    if (!(await guardFlush(direction === 'undo' ? '撤销' : '重做'))) return;
    const cur = workspaceStore.getState()?.current;
    const api = workspaceApi();
    if (!cur || !api) return;
    if (!cur.input) {
      showToast('脚本只读预览不能撤销或重做；返回静态校稿后可继续编辑。', 'error');
      return;
    }
    const result = await api.edit(cur.id, { kind: 'history', value: {
      stateRevision: cur.input.stateRevision, draftRevision: cur.input.draftRevision, direction,
    } });
    if (!result.ok) showToast(describeCode(result.code), 'error');
  }), [runBusy, guardFlush, showToast, blockedByMaintenance]);

  const onSaveCopy = useCallback(() => void runBusy(async () => {
    if (blockedByMaintenance()) return;
    if (!(await guardFlush('另存草稿'))) return;
    const cur = workspaceStore.getState()?.current;
    const api = workspaceApi();
    if (!cur || !api) return;
    if (!cur.input) {
      showToast('脚本只读预览没有可另存的草稿；返回静态校稿后再操作。', 'error');
      return;
    }
    const result = await api.edit(cur.id, { kind: 'save-copy', stateRevision: cur.input.stateRevision });
    const copy = result.copy;
    if (copy?.status === 'created') showToast(`草稿副本已保存：${copy.name}`);
    else if (copy?.status === 'cancelled') showToast('已取消另存。');
    else if (copy) showToast(`另存失败${copy.code ? `（${copy.code}）` : '。'}`, 'error');
    else showToast(describeCode(result.code), 'error');
  }), [runBusy, guardFlush, showToast, blockedByMaintenance]);

  const onPanel = useCallback((mode: PanelMode) => void runBusy(async () => {
    if (blockedByMaintenance()) return;
    if (!(await guardFlush(mode === 'hidden' ? '隐藏校稿栏' : mode === 'floating' ? '拆卸校稿栏' : '停靠校稿栏'))) return;
    await desktopApi()?.request({ kind: 'panel', mode });
  }), [runBusy, guardFlush, blockedByMaintenance]);

  const handleSaveResult = useCallback((result: WorkspaceResult, documentId: string): boolean => {
    const verdict = classifySaveResult(result, documentId);
    switch (verdict.kind) {
      case 'saved':
        showToast(verdict.cleanupPending
          ? '已保存 HTML 文件（临时文件清理待处理，不影响保存内容）。'
          : '已保存 HTML 文件。');
        return true;
      case 'unchanged':
        showToast('没有需要写入的修改。');
        return true;
      case 'cancelled':
        setSaveError({ message: '保存已取消，文件未被写入。', code: verdict.code, conflict: false });
        return false;
      case 'rebase-required':
        // A native commit happened but the UI rebind failed: the file may
        // already contain the changes. Never claim it was not written.
        setSaveError({
          message: '保存已提交，但按新文件版本重建草稿未完成。文件可能已包含本次修改；草稿与证据均已保留。请勿直接重试保存，可用“另存草稿”保留修改后再处理。',
          code: verdict.code,
          conflict: true,
        });
        return false;
      case 'unknown':
        // 断连可能发生在 native commit 之后、报告到达之前；缺失或旧文档的
        // 报告都不能断言未写盘。
        setSaveError({
          message: '保存结果未知：文件可能已写入也可能未写入。草稿与事务证据已保留，请先核对文件内容，不要盲目重试。',
          code: verdict.code,
          conflict: true,
        });
        return false;
      case 'failed':
        // 仅限匹配本次 documentId 的权威提交前失败：写入确实未提交。
        setSaveError({
          message: '保存未完成，写入未提交；草稿与证据已保留。',
          code: verdict.code,
          conflict: false,
        });
        return false;
    }
    return false;
  }, [showToast]);

  const onSave = useCallback(() => void runBusy(async () => {
    setSaveError(null);
    if (blockedByMaintenance()) return;
    if (!(await guardFlush('保存'))) return;
    const latest = workspaceStore.getState();
    const cur = latest?.current;
    const api = workspaceApi();
    if (!latest || !cur || !api) return;
    if (!cur.input) {
      showToast('脚本只读预览不能保存；返回静态校稿后再保存。', 'error');
      return;
    }
    const changes = cur.input.changes;
    if (changes.length === 0) {
      showToast('当前没有净修改，无需保存。');
      return;
    }
    const reviewed = new Set(reviewChannel.currentReviewed(latest.desktop?.reviewed ?? []));
    if (!changes.every(change => reviewed.has(change.nodeId))) {
      showToast('还有未复核的修改：请在校稿栏下方的复核列表勾选全部条目。', 'error');
      if (narrow) setDrawerOpen(true);
      return;
    }
    const { draftRevision, candidateHash } = cur.input;
    const diffResult = await api.readDiff(cur.id, draftRevision, candidateHash);
    if (!diffResult.ok || !diffResult.diff) {
      setSaveError({ message: '无法读取源 Diff，保存已取消。', code: diffResult.code, conflict: false });
      setDiff(null);
      setDialog('diff');
      return;
    }
    setDiff(diffResult.diff);
    setDialog('diff');
  }), [runBusy, guardFlush, showToast, handleSaveResult, narrow, blockedByMaintenance]);

  const onConfirmSave = useCallback(() => void runBusy(async () => {
    if (!diff) return;
    if (blockedByMaintenance()) return;
    const latest = workspaceStore.getState();
    const api = workspaceApi();
    if (!latest || !api) return;
    const result = await api.save(diff.documentId, latest.stateRevision, {
      draftRevision: diff.draftRevision, candidateHash: diff.candidateHash,
    });
    if (handleSaveResult(result, diff.documentId)) {
      setDialog(null);
      setDiff(null);
    }
  }), [runBusy, diff, handleSaveResult, blockedByMaintenance]);

  const onPdfCreate = useCallback(() => void runBusy(async () => {
    setPdfError(null);
    if (blockedByMaintenance()) return;
    if (!(await guardFlush('生成 PDF'))) return;
    const cur = workspaceStore.getState()?.current;
    const desktop = desktopApi();
    if (!cur || !desktop) return;
    if (!cur.input) {
      setPdfError('脚本只读预览不能生成草稿 PDF；返回静态校稿后再生成。');
      return;
    }
    const result = await desktop.request({
      kind: 'pdf-create', documentId: cur.id,
      draftRevision: cur.input.draftRevision, candidateHash: cur.input.candidateHash,
      options: pdfOptions,
    });
    if (!result.ok) setPdfError(describeCode(result.code));
  }), [runBusy, guardFlush, pdfOptions, blockedByMaintenance]);

  const pdf = state.desktop?.pdf ?? null;
  const pdfBelongsToCurrent = !!pdf && !!current && pdf.documentId === current.id;
  const pdfStale = pdfBelongsToCurrent && !!input
    && (pdf!.draftRevision !== input.draftRevision || pdf!.candidateHash !== input.candidateHash);
  const lastPdfExport = useRef<string | null>(null);
  useEffect(() => {
    const exported = state.desktop?.pdfExport ?? null;
    if (!exported) {
      lastPdfExport.current = null;
      return;
    }
    const key = `${exported.status}:${exported.name ?? ''}:${exported.code ?? ''}`;
    if (key === lastPdfExport.current) return;
    lastPdfExport.current = key;
    if (exported.status === 'created') showToast(`PDF 已导出${exported.name ? `：${exported.name}` : '。'}`);
    else if (exported.status === 'cancelled') showToast('已取消导出，未生成文件。');
    else if (exported.status === 'failed') showToast(`PDF 导出失败，目标文件未写出${exported.code ? `（${exported.code}）` : '。'}`, 'error');
    else showToast(`PDF 导出结果未知：目标文件可能不完整，请核对后再使用${exported.code ? `（${exported.code}）` : '。'}`, 'error');
  }, [state, showToast]);

  const openRecovery = useCallback(() => {
    const gen = recoveryLife.open();
    if (gen === null) return; // an accepted restore is in flight; never reset it
    const isCurrent = () => recoveryLife.isCurrent(gen);
    const apply = (view: { loading: boolean; catalog: WorkspaceRecoveryCatalog | null; error: string | null }) =>
      setRecovery(value => ({ ...value, ...view }));
    setDialog('recovery');
    setRecovery({ loading: true, catalog: null, error: null, busySession: null });
    const api = workspaceApi();
    if (!api) {
      apply({ loading: false, catalog: null, error: describeCode('MISSING_WORKSPACE_API') });
      return;
    }
    void loadRecoveryCatalog(() => api.listRecovery(), isCurrent, apply);
  }, [recoveryLife]);

  const closeRecovery = useCallback(() => {
    if (!recoveryLife.close()) return; // an accepted restore is in flight; stays visible
    setDialog(null);
  }, [recoveryLife]);

  const openInterruption = useCallback(() => {
    const gen = interruptionLife.open();
    if (gen === null) return; // an accepted check is in flight; never reset it
    setInterruptionError(null);
    menuButtonRef.current?.focus(); // the menu item unmounts; capture a stable return target first
    setDialog('interruption');
  }, [interruptionLife]);

  const closeInterruption = useCallback(() => {
    if (!interruptionLife.close()) return; // an accepted check is in flight; stays visible
    setDialog(null);
  }, [interruptionLife]);

  // The BusyGuard is claimed synchronously before the first await, so a
  // same-frame duplicate click or a competing Ctrl+O never opens a second
  // native chooser. The recovery action latch is claimed synchronously inside
  // the acquired guard, before the first await: a same-event-loop Escape/close
  // or reopen can never hide or reset the accepted flow even before the locked
  // dialog re-renders. busySession locks the dialog until the flow settles.
  const onRestore = useCallback((sessionId: string, sourceMode: RecoverySourceMode) => {
    const gen = recoveryLife.current();
    void runBusy(async () => {
      if (!recoveryLife.acquire()) return;
      if (blockedByMaintenance()) { recoveryLife.release(); return; }
      setRecovery(value => ({ ...value, busySession: sessionId, error: null }));
      // Results apply only while the originating opening is current and the
      // recovery dialog is still the one on screen: a late restore result
      // must never close a dialog the user opened in the meantime.
      const belongs = () => recoveryLife.isCurrent(gen) && dialogRef.current === 'recovery';
      try {
        await runRecoveryRestore({
          getState: () => workspaceStore.getState(),
          isComposing: () => controller.isComposing(),
          flush: () => guardFlush('恢复草稿记录'),
          restore: (id, stateRevision, mode) => {
            const api = workspaceApi();
            if (!api) return Promise.resolve({ ok: false, code: 'MISSING_WORKSPACE_API', state: null, documentId: null, copy: null, outcome: null });
            return api.restore(id, stateRevision, mode);
          },
          onError: text => { if (belongs()) setRecovery(value => ({ ...value, error: text })); },
          onRestored: () => {
            if (!belongs()) return;
            recoveryLife.invalidate();
            setDialog(null);
          },
        }, { sessionId, sourceMode });
      } finally {
        recoveryLife.release();
        if (recoveryLife.isCurrent(gen)) {
          setRecovery(value => value.busySession === sessionId ? { ...value, busySession: null } : value);
        }
      }
    });
  }, [runBusy, guardFlush, controller, recoveryLife, blockedByMaintenance]);

  // Same synchronous ordering as restore: BusyGuard first, then the
  // interruption action latch, both before the first await — a same-frame
  // duplicate click, Escape/close or menu reopen can never start a second
  // check or hide the accepted one. The reply is only a transport ack: ok
  // never closes the dialog or claims a repair; the displayed outcome is
  // Main's onState interruption.result.
  const onCheckInterruption = useCallback(() => {
    const gen = interruptionLife.current();
    void runBusy(async () => {
      if (!interruptionLife.acquire()) return;
      const belongs = () => interruptionLife.isCurrent(gen) && dialogRef.current === 'interruption';
      if (belongs()) setInterruptionError(null);
      setInterruptionChecking(true);
      try {
        await runInterruptionCheck({
          getState: () => workspaceStore.getState(),
          isComposing: () => controller.isComposing(),
          flush: () => guardFlush('检查中断'),
          inspect: stateRevision => {
            const api = desktopApi();
            if (!api) return Promise.resolve({ ok: false, code: 'MISSING_WORKSPACE_API', state: null, documentId: null, copy: null, outcome: null });
            return api.request({ kind: 'inspect-interruption', stateRevision });
          },
          onError: text => { if (belongs()) setInterruptionError(text); },
        });
      } finally {
        interruptionLife.release();
        setInterruptionChecking(false);
      }
    });
  }, [runBusy, guardFlush, controller, interruptionLife]);

  const openBackups = useCallback(() => {
    const cur = workspaceStore.getState()?.current;
    if (!cur) return;
    setDialog('backups');
    setBackups({ loading: true, catalog: null, error: null, busy: false });
    void workspaceApi()?.listBackups(cur.id).then(result => {
      setBackups({ loading: false, catalog: result.backups ?? null, error: result.ok ? null : describeCode(result.code), busy: false });
    });
  }, []);

  const onRestoreBackup = useCallback((backup: BackupSummary) => void runBusy(async () => {
    if (blockedByMaintenance()) return;
    if (!(await guardFlush('恢复备份'))) return;
    const latest = workspaceStore.getState();
    const cur = latest?.current;
    const api = workspaceApi();
    if (!latest || !cur || !api) return;
    if (!cur.input) {
      setBackups(value => ({ ...value, error: '脚本只读预览下不能恢复备份；返回静态校稿后再恢复。' }));
      return;
    }
    setBackups(value => ({ ...value, busy: true, error: null }));
    const result = await api.restoreBackup(cur.id, latest.stateRevision, backup.reference);
    setBackups(value => ({ ...value, busy: false }));
    if (result.ok && result.outcome === 'backup-restored') {
      setDialog(null);
      showToast('已从备份恢复文件。');
    } else if (result.outcome !== 'cancelled') {
      setBackups(value => ({ ...value, error: describeCode(result.code) }));
    }
  }), [runBusy, guardFlush, showToast, blockedByMaintenance]);

  const onRetryPersistence = useCallback(() => {
    if (blockedByMaintenance()) return;
    const cur = workspaceStore.getState();
    const currentDoc = cur?.current;
    const api = workspaceApi();
    if (!currentDoc?.persistence || !currentDoc.input || !api) return;
    void api.retryPersistence(currentDoc.id, currentDoc.input.draftRevision);
  }, [blockedByMaintenance]);

  // Global shortcuts. Composition never triggers app-level actions.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || controller.isComposing()) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const inTextarea = event.target instanceof HTMLTextAreaElement;
      const key = event.key.toLowerCase();
      // 中断检查或待复核期间，写入/打开/恢复快捷键一律不发起（Main 也会拒绝）。
      const gate = interruptionGate(workspaceStore.getState());
      if (gate && ['o', 's', 'z', 'y'].includes(key)) {
        event.preventDefault();
        showToast(interruptionGateText(gate), 'error');
        return;
      }
      if (key === 'o' && !event.shiftKey) { event.preventDefault(); onOpen(false); return; }
      // 脚本只读预览：编辑、撤销/重做与保存快捷键明确拒绝，不静默也不冒充成功。
      if (workspaceStore.getState()?.current?.mode === 'interactive' && ['s', 'z', 'y'].includes(key)) {
        event.preventDefault();
        showToast('脚本只读预览不能编辑或保存；可使用工具栏“返回静态校稿”。', 'error');
        return;
      }
      if (key === 's' && event.shiftKey) { event.preventDefault(); onSaveCopy(); }
      else if (key === 's') { event.preventDefault(); onSave(); }
      else if (key === 'z' && !inTextarea) { event.preventDefault(); onHistory(event.shiftKey ? 'redo' : 'undo'); }
      else if (key === 'y' && !inTextarea) { event.preventDefault(); onHistory('redo'); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, onOpen, onSave, onSaveCopy, onHistory, showToast]);

  const persistence = current?.persistence ?? null;
  const changes = input?.changes ?? [];
  const reviewedCount = state.desktop?.reviewed.length ?? 0;
  const allReviewed = changes.length > 0 && changes.every(change => (state.desktop?.reviewed ?? []).includes(change.nodeId));
  const dirtyDocument = changes.length > 0 || (input?.hasUnappliedInput ?? false);
  const history = input?.history ?? null;
  const phaseBusy = state.phase === 'choosing' || state.phase === 'opening' || state.phase === 'saving' || state.phase === 'committing';
  const lastSave = state.lastSave;
  // Main 中断检查进行中或结果待复核时，本窗口的写入/打开/恢复控件全部停用；
  // “检查上次中断”的说明/结果对话框仍可查看。
  const maintenance = interruptionGate(state);
  const maintenanceOn = maintenance !== null;
  const switchBlocker = entrySwitchBlocker(state, { busy: busy || maintenanceOn, composing: inputView.composing });
  const switchTitle = (fallback: (blocker: NonNullable<typeof switchBlocker>) => string): string | undefined =>
    !switchBlocker ? undefined : maintenance && !busy ? interruptionGateText(maintenance) : fallback(switchBlocker);

  const docked = panel === 'docked' && !!current;
  return (
    <div className={docked ? 'app' : 'app no-panel'}>
      <header className="toolbar">
        <div className="tb-group tb-doc">
          <span className="doc-name">{current?.name ?? '未打开文档'}</span>
          {current && <span className={readonly ? 'mode-badge readonly' : 'mode-badge'}>{readonly ? '只读预览' : '静态校稿'}</span>}
          {dirtyDocument && <span className="doc-flag">未保存</span>}
        </div>
        <div className="tb-group collapsible">
          <button type="button" className="btn" disabled={busy || phaseBusy || maintenanceOn} onClick={() => onOpen(false)}>
            <IconOpen />打开 HTML
          </button>
          <button type="button" className="btn" disabled={busy || phaseBusy || maintenanceOn} onClick={() => onOpen(true)}>
            <IconFolder />打开目录
          </button>
        </div>
        <div className="tb-group">
          <button type="button" className="btn icon" aria-label={`撤销（${history?.undoCount ?? 0} 条）`}
            title={readonly ? '脚本只读预览不能撤销；返回静态校稿后可继续编辑。' : undefined}
            disabled={busy || maintenanceOn || readonly || !history?.canUndo || inputView.composing} onClick={() => onHistory('undo')}>
            <IconUndo />
          </button>
          <button type="button" className="btn icon" aria-label={`重做（${history?.redoCount ?? 0} 条）`}
            title={readonly ? '脚本只读预览不能重做；返回静态校稿后可继续编辑。' : undefined}
            disabled={busy || maintenanceOn || readonly || !history?.canRedo || inputView.composing} onClick={() => onHistory('redo')}>
            <IconRedo />
          </button>
        </div>
        <div className="tb-spacer" />
        <div className="tb-group">
          <button type="button" className="btn collapsible" disabled={switchBlocker !== null}
            title={switchTitle(modeSwitchBlockerText) ?? (readonly
              ? '停止页面脚本并重新加载为静态校稿；有未保存修改时会先提供取消、放弃或另存草稿的选择。'
              : '离线运行页面本地脚本查看效果；动态文字不能编辑，也不会写回 HTML。')}
            onClick={onSwitchMode}>
            <IconMode />{switchingMode ? '正在切换…' : modeSwitchTarget(current?.mode) === 'interactive' ? '只读预览' : '返回静态校稿'}
          </button>
          <button type="button" className="btn narrow-only" disabled={!changes.length} onClick={() => setDrawerOpen(true)}>
            变更 <span className={changes.length ? 'count has' : 'count'}>{changes.length}</span>
          </button>
          <button type="button" className="btn primary" disabled={busy || phaseBusy || maintenanceOn || !current || readonly || !state.canSave}
            title={readonly ? '脚本只读预览不能保存；返回静态校稿后再保存。' : undefined}
            onClick={onSave}>
            <IconSave />{changes.length ? `复核并保存（${reviewedCount}/${changes.length}）` : '保存'}
          </button>
          <button type="button" className="btn collapsible" disabled={busy || maintenanceOn || !current || readonly || state.desktop?.pdfBusy}
            title={readonly ? '脚本只读预览不能生成草稿 PDF；返回静态校稿后再生成。' : undefined}
            onClick={() => { setPdfError(null); setDialog('pdf'); }}>
            <IconPdf />PDF
          </button>
          {panel === 'docked' && <>
            <button type="button" className="btn icon" aria-label="隐藏校稿栏" disabled={busy || maintenanceOn} onClick={() => onPanel('hidden')}>
              <IconPanelHide />
            </button>
            <button type="button" className="btn icon" aria-label="在独立窗口中校稿" disabled={busy || maintenanceOn} onClick={() => onPanel('floating')}>
              <IconFloat />
            </button>
          </>}
          {panel === 'hidden' && (
            <button type="button" className="btn" disabled={busy || maintenanceOn} onClick={() => onPanel('docked')}>
              <IconPanelShow />恢复校稿栏
            </button>
          )}
          {panel === 'floating' && (
            <button type="button" className="btn" disabled={busy || maintenanceOn} onClick={() => onPanel('docked')}>
              <IconDock />收回校稿栏
            </button>
          )}
          <div className="menu-wrap" ref={menuWrapRef}>
            <button type="button" className="btn icon" aria-label="更多操作" aria-haspopup="menu"
              aria-expanded={menuOpen} ref={menuButtonRef} onClick={() => setMenuOpen(value => !value)}>
              <IconMenu />
            </button>
            {menuOpen && <div className="menu" role="menu">
              <button type="button" role="menuitem" className="narrow-only" disabled={maintenanceOn} onClick={() => { setMenuOpen(false); onOpen(false); }}>打开 HTML…</button>
              <button type="button" role="menuitem" className="narrow-only" disabled={maintenanceOn} onClick={() => { setMenuOpen(false); onOpen(true); }}>打开目录…</button>
              <button type="button" role="menuitem" disabled={switchBlocker !== null}
                title={switchTitle(entrySwitchBlockerText)}
                onClick={() => { setMenuOpen(false); menuButtonRef.current?.focus(); onSwitchEntry(); }}>
                {switching ? '正在切换目录内 HTML…' : '切换目录内 HTML…'}
                {current && <span className="menu-sub">{`${current.project.name} / ${current.project.entry}`}</span>}
              </button>
              <button type="button" role="menuitem" disabled={switchBlocker !== null}
                title={switchTitle(modeSwitchBlockerText)}
                onClick={() => { setMenuOpen(false); menuButtonRef.current?.focus(); onSwitchMode(); }}>
                {switchingMode ? '正在切换模式…' : readonly ? '返回静态校稿' : '切换为脚本只读预览'}
                <span className="menu-sub">{readonly
                  ? '停止页面脚本并重新加载为静态校稿；动态文字仍不能写回。'
                  : '离线运行页面本地脚本查看效果；动态文字不能编辑。有未保存修改时会先提供取消、放弃或另存草稿的选择。'}</span>
              </button>
              <button type="button" role="menuitem" className="narrow-only" disabled={!current || readonly || maintenanceOn}
                onClick={() => { setMenuOpen(false); setPdfError(null); setDialog('pdf'); }}>PDF 打印预览…</button>
              <button type="button" role="menuitem" disabled={!current || !input?.canSaveCopy || maintenanceOn}
                onClick={() => { setMenuOpen(false); onSaveCopy(); }}>另存草稿…</button>
              <button type="button" role="menuitem" disabled={maintenanceOn}
                title={maintenance ? interruptionGateText(maintenance) : undefined}
                onClick={() => { setMenuOpen(false); openRecovery(); }}>恢复草稿记录…</button>
              <button type="button" role="menuitem" disabled={!current || maintenanceOn}
                onClick={() => { setMenuOpen(false); openBackups(); }}>备份与恢复…</button>
              <button type="button" role="menuitem"
                onClick={() => { setMenuOpen(false); openInterruption(); }}>检查上次中断…
                <span className="menu-sub">检查上次退出时是否有未完成的保存或旧记录清理；确认前只读取。</span>
              </button>
              <button type="button" role="menuitem" disabled={!current}
                onClick={() => { setMenuOpen(false); setDialog('resources'); }}>资源诊断…</button>
              <button type="button" role="menuitem" onClick={() => setMenuOpen(false)}>关闭菜单</button>
            </div>}
          </div>
        </div>
      </header>
      <div className="banners">
        {readonly && (
          <div className="banner readonly-banner" role="status">
            脚本只读预览：离线运行页面本地脚本，显示源文件效果；动态文字不能编辑，编辑、复核、保存与草稿 PDF 已停用。
            <span className="conflict-actions">
              <button type="button" className="btn sm" disabled={switchBlocker !== null}
                title={switchTitle(modeSwitchBlockerText) ?? '重新加载页面并停止脚本；返回后可继续校对。'}
                onClick={onSwitchMode}>
                {switchingMode ? '正在返回…' : '返回静态校稿'}
              </button>
            </span>
          </div>
        )}
        {input?.mappingStatus === 'invalidated' && (
          <div className="banner readonly-banner" role="alert">
            页面映射已失效{input.mappingReason ? `（${input.mappingReason}）` : ''}，编辑已暂停；请重新打开文档。
          </div>
        )}
        {current && lastSave && lastSave.documentId === current.id && (lastSave.status === 'failed' || lastSave.status === 'unknown') && (
          <div className="banner conflict-banner" role="alert">
            {lastSave.status === 'failed'
              ? `上次保存未完成，写入未提交${lastSave.code ? `（${lastSave.code}）` : ''}；草稿与证据已保留。`
              : `上次保存结果未知${lastSave.code ? `（${lastSave.code}）` : ''}，文件可能已写入；请勿盲目重试，可先另存草稿保留修改。`}
            <span className="conflict-actions">
              <button type="button" className="btn sm" disabled={!input?.canSaveCopy || maintenanceOn} onClick={onSaveCopy}>另存草稿…</button>
            </span>
          </div>
        )}
        {current && lastSave?.status === 'rebase-required' && lastSave.documentId === current.id && (
          <div className="banner conflict-banner" role="alert">
            保存已提交，但按新文件版本重建草稿未完成；文件可能已包含本次修改。草稿与证据已保留，请勿直接重试保存。
            <span className="conflict-actions">
              <button type="button" className="btn sm" disabled={!input?.canSaveCopy || maintenanceOn} onClick={onSaveCopy}>另存草稿…</button>
            </span>
          </div>
        )}
        {persistence?.status === 'failed' && (
          <div className="banner readonly-banner" role="alert">
            草稿记录写入失败{persistence.code ? `（${persistence.code}）` : ''}，当前修改仍在内存中。
            {persistence.canRetry && <span className="conflict-actions">
              <button type="button" className="btn sm" disabled={maintenanceOn} onClick={onRetryPersistence}>重试写入</button>
            </span>}
          </div>
        )}
        {state.desktop?.error && (
          <div className="banner readonly-banner" role="alert">桌面操作未完成：{state.desktop.error}</div>
        )}
      </div>
      <div className="preview">
        <div className="preview-host" ref={previewRef}>
          {!current && (
            <div className="empty">
              <h2>打开一个 HTML 文件开始校对</h2>
              <p>在预览中点击一段文字即可修改，停顿后自动更新预览；逐条复核后点击“保存”才会写回原文件（自动备份）。</p>
              <p className="hint">支持范围：静态 HTML 中可安全映射的文字；脚本动态生成的内容以只读预览显示，不能修改。</p>
              <div className="editor-actions">
                <button type="button" className="btn primary" disabled={busy || phaseBusy || maintenanceOn} data-autofocus onClick={() => onOpen(false)}>
                  <IconOpen />打开 HTML 文件…
                </button>
                <button type="button" className="btn" disabled={busy || phaseBusy || maintenanceOn} onClick={() => onOpen(true)}>
                  <IconFolder />打开目录…
                </button>
              </div>
            </div>
          )}
          {current && (state.phase === 'opening' || input?.mappingStatus === 'binding') && (
            <div className="empty"><p role="status">正在准备预览…</p></div>
          )}
        </div>
      </div>
      {docked && (
        <aside className="editor-panel" aria-label="校稿栏">
          <EditorPanel hasDocument={!!current} mode={current?.mode ?? 'proofread'} input={input} controller={controller} onRetryBegin={onRetryBegin} />
        </aside>
      )}
      {docked && (
        <section className="changes-panel" aria-label="复核列表">
          <ReviewPanel changes={changes} reviewed={effectiveReviewed} pending={reviewStatus.pending} readonly={readonly} />
        </section>
      )}
      <footer className="statusbar">
        <span className="st-item" role="status">
          {!current && '未打开文档'}
          {current && readonly && '脚本只读预览 · 不能编辑'}
          {current && !readonly && inputView.composing && '组词中'}
          {current && !readonly && !inputView.composing && (inputView.busy || inputView.applying) && '正在更新预览…'}
          {current && !readonly && !inputView.composing && !inputView.busy && !inputView.applying && inputView.dirty && '有待预览的输入'}
          {current && !readonly && !inputView.composing && !inputView.busy && !inputView.applying && !inputView.dirty
            && (changes.length ? `${changes.length} 条未保存修改${allReviewed ? '，已全部复核' : ''}` : '无未保存修改')}
        </span>
        {persistence && <span className={persistence.status === 'failed' || persistence.status === 'unknown' ? 'st-item warn' : 'st-item'}>
          {persistence.status === 'persisted' && '草稿记录已写入'}
          {persistence.status === 'writing' && '正在写入草稿记录…'}
          {persistence.status === 'idle' && '草稿记录待写入'}
          {persistence.status === 'failed' && '草稿记录写入失败'}
          {persistence.status === 'unknown' && '草稿记录状态未知'}
        </span>}
        {state.cleanupPending && <span className="st-item warn">有待清理的临时文件</span>}
        {maintenance && <span className="st-item warn" role="status">{interruptionGateText(maintenance)}</span>}
        {current && current.project.resources.items.length > 0 && (
          <button type="button" className="st-btn" onClick={() => setDialog('resources')}>
            资源：{current.project.resources.items.length} 项被阻断
          </button>
        )}
        {pdf && <button type="button" className="st-btn" disabled={maintenanceOn} onClick={() => { setPdfError(null); setDialog('pdf'); }}>
          PDF：{pdf.name}{!pdfBelongsToCurrent ? '（先前快照）' : pdfStale ? '（可能已过期）' : ''}
        </button>}
        <span className="st-spacer" />
        <span className="st-hint">{readonly ? '只读预览不写入 HTML 文件' : '实时预览不写入 HTML 文件'}</span>
      </footer>
      {drawerOpen && narrow && (
        <Dialog title="复核变更" drawer onClose={() => setDrawerOpen(false)}>
          <ReviewPanel changes={changes} reviewed={effectiveReviewed} pending={reviewStatus.pending} readonly={readonly} />
        </Dialog>
      )}
      {dialog === 'diff' && (diff ? (
        <SaveDiffDialog diff={diff} saving={busy} error={saveError} canSaveCopy={input?.canSaveCopy ?? false}
          onConfirmSave={onConfirmSave}
          onSaveCopy={() => { setDialog(null); setDiff(null); onSaveCopy(); }}
          onClose={() => { setDialog(null); setDiff(null); }} />
      ) : (
        <SaveDiffFallback error={saveError} onClose={() => { setDialog(null); setSaveError(null); }} />
      ))}
      {dialog === 'pdf' && (
        <PdfDialog pdf={pdf} pdfBusy={state.desktop?.pdfBusy ?? false} stale={pdfStale} readonly={readonly}
          belongsToCurrent={pdfBelongsToCurrent}
          options={pdfOptions} error={pdfError}
          onOptions={setPdfOptions} onCreate={onPdfCreate}
          onShow={id => void desktopApi()?.request({ kind: 'pdf-show', id })}
          onExport={id => void desktopApi()?.request({ kind: 'pdf-export', id })}
          onDiscard={() => void desktopApi()?.request({ kind: 'pdf-close' })}
          onClose={() => setDialog(null)} />
      )}
      {dialog === 'recovery' && (
        <RecoveryDialog catalog={recovery.catalog} loading={recovery.loading}
          busySession={recovery.busySession} error={recovery.error}
          onRestore={onRestore} onClose={closeRecovery} />
      )}
      {dialog === 'interruption' && (
        <InterruptionDialog interruption={state.desktop?.interruption ?? null}
          blocker={interruptionBlocker(state, { busy: busy && !interruptionChecking, composing: inputView.composing })}
          checking={interruptionChecking} error={interruptionError}
          onCheck={onCheckInterruption} onClose={closeInterruption} />
      )}
      {dialog === 'backups' && (
        <BackupsDialog catalog={backups.catalog} loading={backups.loading}
          busy={backups.busy} readonly={readonly} error={backups.error}
          onRestore={onRestoreBackup} onClose={() => setDialog(null)} />
      )}
      {dialog === 'resources' && current && (
        <ResourcesDialog resources={current.project.resources} onClose={() => setDialog(null)} />
      )}
      {toast && <div className={toast.kind === 'error' ? 'toast toast-error' : 'toast'} role="status">{toast.text}</div>}
    </div>
  );
}

function SaveDiffFallback(props: Readonly<{ error: SaveError | null; onClose: () => void }>) {
  return (
    <Dialog title="无法保存" onClose={props.onClose}
      footer={<button type="button" className="btn primary" data-autofocus onClick={props.onClose}>知道了</button>}>
      <p>{props.error?.message ?? '无法读取源 Diff，保存已取消。'}</p>
      {props.error?.code && <p className="hint">代码：{props.error.code}</p>}
    </Dialog>
  );
}

function EditorWindow(props: Readonly<{ state: WorkspaceSnapshot }>) {
  const { state } = props;
  const current = state.current;
  const input = current?.input ?? null;
  const readonly = current?.mode === 'interactive';
  const panel = state.desktop?.panel ?? 'floating';
  const owner = panel === 'floating';
  const controller = useController(state, owner);
  const inputView = useLiveInput(controller);
  useFlushRequests(state, owner, controller);
  const [beginNonce, setBeginNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, showToast] = useToast();
  const reviewStatus = useReviewStatus();
  useEffect(() => { reviewChannel.sync(); }, [state]);
  useEffect(() => {
    if (reviewStatus.errorSeq > 0 && reviewStatus.error) {
      showToast(`复核勾选未被记录：${reviewStatus.error}`, 'error');
    }
  }, [reviewStatus.errorSeq, reviewStatus.error, showToast]);
  const effectiveReviewed = reviewChannel.currentReviewed(state.desktop?.reviewed ?? []);

  useEffect(() => {
    if (!owner || !input || input.input || input.phase !== 'idle' || !input.selection) return;
    const reference = input.selection.reference;
    const key = `${reference.nodeId}:${reference.revision}:${reference.identity.preview.sessionId}:${reference.identity.preview.generation}`;
    void controller.begin(key, reference, input.draftRevision);
  }, [owner, input, controller, beginNonce]);

  const onDock = useCallback(() => {
    if (busy) return;
    // 中断检查/待复核期间不停靠（Main 也会拒绝）；说明仍在主窗口查看。
    const gate = interruptionGate(workspaceStore.getState());
    if (gate) {
      showToast(interruptionGateText(gate), 'error');
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        if (!(await controller.flush())) {
          showToast('请先完成当前输入（可能在组词或投递失败），再停靠。', 'error');
          return;
        }
        await desktopApi()?.request({ kind: 'panel', mode: 'docked' });
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, controller, showToast]);

  const changes = input?.changes ?? [];
  const dirtyDocument = changes.length > 0 || (input?.hasUnappliedInput ?? false);

  return (
    <div className="editor-app">
      <header className="toolbar">
        <div className="tb-group tb-doc">
          <span className="doc-name">{current?.name ?? '校稿'}</span>
          {current && <span className={readonly ? 'mode-badge readonly' : 'mode-badge'}>{readonly ? '只读预览' : '静态校稿'}</span>}
          {dirtyDocument && <span className="doc-flag">未保存</span>}
        </div>
        <div className="tb-spacer" />
        <div className="tb-group">
          <button type="button" className="btn" disabled={busy || interruptionGate(state) !== null} onClick={onDock}>
            <IconDock />停靠到主窗口
          </button>
        </div>
      </header>
      <div className="editor-panel float">
        <EditorPanel hasDocument={!!current} mode={current?.mode ?? 'proofread'} input={input} controller={controller}
          onRetryBegin={() => { controller.retry(); setBeginNonce(value => value + 1); }} />
      </div>
      <div className="changes-panel float">
        <ReviewPanel changes={changes} reviewed={effectiveReviewed} pending={reviewStatus.pending} readonly={readonly} />
      </div>
      <footer className="statusbar">
        <span className="st-item" role="status">
          {readonly && '脚本只读预览 · 不能编辑'}
          {!readonly && inputView.composing && '组词中'}
          {!readonly && !inputView.composing && (inputView.busy || inputView.applying) && '正在更新预览…'}
          {!readonly && !inputView.composing && !inputView.busy && !inputView.applying && inputView.dirty && '有待预览的输入'}
          {!readonly && !inputView.composing && !inputView.busy && !inputView.applying && !inputView.dirty
            && (changes.length ? `${changes.length} 条未保存修改` : '无未保存修改')}
        </span>
        <span className="st-spacer" />
        <span className="st-hint">保存在主窗口进行</span>
      </footer>
      {toast && <div className={toast.kind === 'error' ? 'toast toast-error' : 'toast'} role="status">{toast.text}</div>}
    </div>
  );
}
