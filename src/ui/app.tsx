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
import { classifySaveResult } from './save-result.ts';
import { EditorPanel } from './editor-panel.tsx';
import { ReviewPanel } from './review-panel.tsx';
import { reviewChannel, useReviewStatus } from './review-channel.ts';
import { BackupsDialog, PdfDialog, RecoveryDialog, ResourcesDialog, SaveDiffDialog } from './dialogs.tsx';
import { Dialog } from './dialog.tsx';
import type { SaveError } from './dialogs.tsx';
import { describeCode } from './util.ts';
import { IconDock, IconFloat, IconFolder, IconMenu, IconOpen, IconPanelHide, IconPanelShow, IconPdf, IconRedo, IconSave, IconUndo } from './icons.tsx';

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

type DialogKind = 'diff' | 'pdf' | 'recovery' | 'backups' | 'resources';

function MainWindow(props: Readonly<{ state: WorkspaceSnapshot }>) {
  const { state } = props;
  const current = state.current;
  const input = current?.input ?? null;
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

  const [dialog, setDialog] = useState<DialogKind | null>(null);
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
  const [backups, setBackups] = useState<{ loading: boolean; catalog: WorkspaceBackupCatalog | null; error: string | null; busy: boolean }>({ loading: false, catalog: null, error: null, busy: false });

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

  const [switching, setSwitching] = useState(false);
  const onSwitchEntry = useCallback(() => void runBusy(async () => {
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
  }), [runBusy, guardFlush, controller, showToast]);

  const onOpen = useCallback((directory: boolean) => void runBusy(async () => {
    if (!(await guardFlush('打开'))) return;
    const latest = workspaceStore.getState();
    const api = workspaceApi();
    if (!latest || !api) return;
    const result = directory ? await api.openDirectory(latest.stateRevision) : await api.open(latest.stateRevision);
    if (!result.ok) showToast(describeCode(result.code), 'error');
  }), [runBusy, guardFlush, showToast]);

  const onHistory = useCallback((direction: 'undo' | 'redo') => void runBusy(async () => {
    if (!(await guardFlush(direction === 'undo' ? '撤销' : '重做'))) return;
    const cur = workspaceStore.getState()?.current;
    const api = workspaceApi();
    if (!cur || !api) return;
    const result = await api.edit(cur.id, { kind: 'history', value: {
      stateRevision: cur.input.stateRevision, draftRevision: cur.input.draftRevision, direction,
    } });
    if (!result.ok) showToast(describeCode(result.code), 'error');
  }), [runBusy, guardFlush, showToast]);

  const onSaveCopy = useCallback(() => void runBusy(async () => {
    if (!(await guardFlush('另存草稿'))) return;
    const cur = workspaceStore.getState()?.current;
    const api = workspaceApi();
    if (!cur || !api) return;
    const result = await api.edit(cur.id, { kind: 'save-copy', stateRevision: cur.input.stateRevision });
    const copy = result.copy;
    if (copy?.status === 'created') showToast(`草稿副本已保存：${copy.name}`);
    else if (copy?.status === 'cancelled') showToast('已取消另存。');
    else if (copy) showToast(`另存失败${copy.code ? `（${copy.code}）` : '。'}`, 'error');
    else showToast(describeCode(result.code), 'error');
  }), [runBusy, guardFlush, showToast]);

  const onPanel = useCallback((mode: PanelMode) => void runBusy(async () => {
    if (!(await guardFlush(mode === 'hidden' ? '隐藏校稿栏' : mode === 'floating' ? '拆卸校稿栏' : '停靠校稿栏'))) return;
    await desktopApi()?.request({ kind: 'panel', mode });
  }), [runBusy, guardFlush]);

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
    if (!(await guardFlush('保存'))) return;
    const latest = workspaceStore.getState();
    const cur = latest?.current;
    const api = workspaceApi();
    if (!latest || !cur || !api) return;
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
  }), [runBusy, guardFlush, showToast, handleSaveResult, narrow]);

  const onConfirmSave = useCallback(() => void runBusy(async () => {
    if (!diff) return;
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
  }), [runBusy, diff, handleSaveResult]);

  const onPdfCreate = useCallback(() => void runBusy(async () => {
    setPdfError(null);
    if (!(await guardFlush('生成 PDF'))) return;
    const cur = workspaceStore.getState()?.current;
    const desktop = desktopApi();
    if (!cur || !desktop) return;
    const result = await desktop.request({
      kind: 'pdf-create', documentId: cur.id,
      draftRevision: cur.input.draftRevision, candidateHash: cur.input.candidateHash,
      options: pdfOptions,
    });
    if (!result.ok) setPdfError(describeCode(result.code));
  }), [runBusy, guardFlush, pdfOptions]);

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
    setDialog('recovery');
    setRecovery({ loading: true, catalog: null, error: null, busySession: null });
    void workspaceApi()?.listRecovery().then(result => {
      setRecovery({ loading: false, catalog: result.recovery ?? null, error: result.ok ? null : describeCode(result.code), busySession: null });
    });
  }, []);

  const onRestore = useCallback((sessionId: string) => {
    const latest = workspaceStore.getState();
    const api = workspaceApi();
    if (!latest || !api) return;
    void (async () => {
      if (!(await guardFlush('恢复草稿记录'))) return;
      const fresh = workspaceStore.getState();
      if (!fresh) return;
      setRecovery(value => ({ ...value, busySession: sessionId, error: null }));
      const result = await api.restore(sessionId, fresh.stateRevision);
      setRecovery(value => ({ ...value, busySession: null }));
      if (result.ok && result.outcome === 'restored') setDialog(null);
      else if (result.outcome !== 'cancelled') setRecovery(value => ({ ...value, error: describeCode(result.code) }));
    })();
  }, [guardFlush]);

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
    if (!(await guardFlush('恢复备份'))) return;
    const latest = workspaceStore.getState();
    const cur = latest?.current;
    const api = workspaceApi();
    if (!latest || !cur || !api) return;
    setBackups(value => ({ ...value, busy: true, error: null }));
    const result = await api.restoreBackup(cur.id, latest.stateRevision, backup.reference);
    setBackups(value => ({ ...value, busy: false }));
    if (result.ok && result.outcome === 'backup-restored') {
      setDialog(null);
      showToast('已从备份恢复文件。');
    } else if (result.outcome !== 'cancelled') {
      setBackups(value => ({ ...value, error: describeCode(result.code) }));
    }
  }), [runBusy, guardFlush, showToast]);

  const onRetryPersistence = useCallback(() => {
    const cur = workspaceStore.getState();
    const currentDoc = cur?.current;
    const api = workspaceApi();
    if (!currentDoc?.persistence || !api) return;
    void api.retryPersistence(currentDoc.id, currentDoc.input.draftRevision);
  }, []);

  // Global shortcuts. Composition never triggers app-level actions.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || controller.isComposing()) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const inTextarea = event.target instanceof HTMLTextAreaElement;
      const key = event.key.toLowerCase();
      if (key === 'o' && !event.shiftKey) { event.preventDefault(); onOpen(false); }
      else if (key === 's' && event.shiftKey) { event.preventDefault(); onSaveCopy(); }
      else if (key === 's') { event.preventDefault(); onSave(); }
      else if (key === 'z' && !inTextarea) { event.preventDefault(); onHistory(event.shiftKey ? 'redo' : 'undo'); }
      else if (key === 'y' && !inTextarea) { event.preventDefault(); onHistory('redo'); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, onOpen, onSave, onSaveCopy, onHistory]);

  const persistence = current?.persistence ?? null;
  const changes = input?.changes ?? [];
  const reviewedCount = state.desktop?.reviewed.length ?? 0;
  const allReviewed = changes.length > 0 && changes.every(change => (state.desktop?.reviewed ?? []).includes(change.nodeId));
  const dirtyDocument = changes.length > 0 || (input?.hasUnappliedInput ?? false);
  const history = input?.history ?? null;
  const phaseBusy = state.phase === 'choosing' || state.phase === 'opening' || state.phase === 'saving' || state.phase === 'committing';
  const lastSave = state.lastSave;
  const switchBlocker = entrySwitchBlocker(state, { busy, composing: inputView.composing });

  const docked = panel === 'docked' && !!current;
  return (
    <div className={docked ? 'app' : 'app no-panel'}>
      <header className="toolbar">
        <div className="tb-group tb-doc">
          <span className="doc-name">{current?.name ?? '未打开文档'}</span>
          {dirtyDocument && <span className="doc-flag">未保存</span>}
        </div>
        <div className="tb-group collapsible">
          <button type="button" className="btn" disabled={busy || phaseBusy} onClick={() => onOpen(false)}>
            <IconOpen />打开 HTML
          </button>
          <button type="button" className="btn" disabled={busy || phaseBusy} onClick={() => onOpen(true)}>
            <IconFolder />打开目录
          </button>
        </div>
        <div className="tb-group">
          <button type="button" className="btn icon" aria-label={`撤销（${history?.undoCount ?? 0} 条）`}
            disabled={busy || !history?.canUndo || inputView.composing} onClick={() => onHistory('undo')}>
            <IconUndo />
          </button>
          <button type="button" className="btn icon" aria-label={`重做（${history?.redoCount ?? 0} 条）`}
            disabled={busy || !history?.canRedo || inputView.composing} onClick={() => onHistory('redo')}>
            <IconRedo />
          </button>
        </div>
        <div className="tb-spacer" />
        <div className="tb-group">
          <button type="button" className="btn narrow-only" disabled={!changes.length} onClick={() => setDrawerOpen(true)}>
            变更 <span className={changes.length ? 'count has' : 'count'}>{changes.length}</span>
          </button>
          <button type="button" className="btn primary" disabled={busy || phaseBusy || !current || !state.canSave}
            onClick={onSave}>
            <IconSave />{changes.length ? `复核并保存（${reviewedCount}/${changes.length}）` : '保存'}
          </button>
          <button type="button" className="btn collapsible" disabled={busy || !current || state.desktop?.pdfBusy}
            onClick={() => { setPdfError(null); setDialog('pdf'); }}>
            <IconPdf />PDF
          </button>
          {panel === 'docked' && <>
            <button type="button" className="btn icon" aria-label="隐藏校稿栏" disabled={busy} onClick={() => onPanel('hidden')}>
              <IconPanelHide />
            </button>
            <button type="button" className="btn icon" aria-label="在独立窗口中校稿" disabled={busy} onClick={() => onPanel('floating')}>
              <IconFloat />
            </button>
          </>}
          {panel === 'hidden' && (
            <button type="button" className="btn" disabled={busy} onClick={() => onPanel('docked')}>
              <IconPanelShow />恢复校稿栏
            </button>
          )}
          {panel === 'floating' && (
            <button type="button" className="btn" disabled={busy} onClick={() => onPanel('docked')}>
              <IconDock />收回校稿栏
            </button>
          )}
          <div className="menu-wrap" ref={menuWrapRef}>
            <button type="button" className="btn icon" aria-label="更多操作" aria-haspopup="menu"
              aria-expanded={menuOpen} ref={menuButtonRef} onClick={() => setMenuOpen(value => !value)}>
              <IconMenu />
            </button>
            {menuOpen && <div className="menu" role="menu">
              <button type="button" role="menuitem" className="narrow-only" onClick={() => { setMenuOpen(false); onOpen(false); }}>打开 HTML…</button>
              <button type="button" role="menuitem" className="narrow-only" onClick={() => { setMenuOpen(false); onOpen(true); }}>打开目录…</button>
              <button type="button" role="menuitem" disabled={switchBlocker !== null}
                title={switchBlocker ? entrySwitchBlockerText(switchBlocker) : undefined}
                onClick={() => { setMenuOpen(false); menuButtonRef.current?.focus(); onSwitchEntry(); }}>
                {switching ? '正在切换目录内 HTML…' : '切换目录内 HTML…'}
                {current && <span className="menu-sub">{`${current.project.name} / ${current.project.entry}`}</span>}
              </button>
              <button type="button" role="menuitem" className="narrow-only" disabled={!current}
                onClick={() => { setMenuOpen(false); setPdfError(null); setDialog('pdf'); }}>PDF 打印预览…</button>
              <button type="button" role="menuitem" disabled={!current || !input?.canSaveCopy}
                onClick={() => { setMenuOpen(false); onSaveCopy(); }}>另存草稿…</button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); openRecovery(); }}>恢复草稿记录…</button>
              <button type="button" role="menuitem" disabled={!current}
                onClick={() => { setMenuOpen(false); openBackups(); }}>备份与恢复…</button>
              <button type="button" role="menuitem" disabled={!current}
                onClick={() => { setMenuOpen(false); setDialog('resources'); }}>资源诊断…</button>
              <button type="button" role="menuitem" onClick={() => setMenuOpen(false)}>关闭菜单</button>
            </div>}
          </div>
        </div>
      </header>
      <div className="banners">
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
              <button type="button" className="btn sm" disabled={!input?.canSaveCopy} onClick={onSaveCopy}>另存草稿…</button>
            </span>
          </div>
        )}
        {current && lastSave?.status === 'rebase-required' && lastSave.documentId === current.id && (
          <div className="banner conflict-banner" role="alert">
            保存已提交，但按新文件版本重建草稿未完成；文件可能已包含本次修改。草稿与证据已保留，请勿直接重试保存。
            <span className="conflict-actions">
              <button type="button" className="btn sm" disabled={!input?.canSaveCopy} onClick={onSaveCopy}>另存草稿…</button>
            </span>
          </div>
        )}
        {persistence?.status === 'failed' && (
          <div className="banner readonly-banner" role="alert">
            草稿记录写入失败{persistence.code ? `（${persistence.code}）` : ''}，当前修改仍在内存中。
            {persistence.canRetry && <span className="conflict-actions">
              <button type="button" className="btn sm" onClick={onRetryPersistence}>重试写入</button>
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
                <button type="button" className="btn primary" disabled={busy || phaseBusy} data-autofocus onClick={() => onOpen(false)}>
                  <IconOpen />打开 HTML 文件…
                </button>
                <button type="button" className="btn" disabled={busy || phaseBusy} onClick={() => onOpen(true)}>
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
          <EditorPanel hasDocument={!!current} input={input} controller={controller} onRetryBegin={onRetryBegin} />
        </aside>
      )}
      {docked && (
        <section className="changes-panel" aria-label="复核列表">
          <ReviewPanel changes={changes} reviewed={effectiveReviewed} pending={reviewStatus.pending} />
        </section>
      )}
      <footer className="statusbar">
        <span className="st-item" role="status">
          {!current && '未打开文档'}
          {current && inputView.composing && '组词中'}
          {current && !inputView.composing && (inputView.busy || inputView.applying) && '正在更新预览…'}
          {current && !inputView.composing && !inputView.busy && !inputView.applying && inputView.dirty && '有待预览的输入'}
          {current && !inputView.composing && !inputView.busy && !inputView.applying && !inputView.dirty
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
        {current && current.project.resources.items.length > 0 && (
          <button type="button" className="st-btn" onClick={() => setDialog('resources')}>
            资源：{current.project.resources.items.length} 项被阻断
          </button>
        )}
        {pdf && <button type="button" className="st-btn" onClick={() => { setPdfError(null); setDialog('pdf'); }}>
          PDF：{pdf.name}{!pdfBelongsToCurrent ? '（先前快照）' : pdfStale ? '（可能已过期）' : ''}
        </button>}
        <span className="st-spacer" />
        <span className="st-hint">实时预览不写入 HTML 文件</span>
      </footer>
      {drawerOpen && narrow && (
        <Dialog title="复核变更" drawer onClose={() => setDrawerOpen(false)}>
          <ReviewPanel changes={changes} reviewed={effectiveReviewed} pending={reviewStatus.pending} />
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
        <PdfDialog pdf={pdf} pdfBusy={state.desktop?.pdfBusy ?? false} stale={pdfStale}
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
          onRestore={onRestore} onClose={() => setDialog(null)} />
      )}
      {dialog === 'backups' && (
        <BackupsDialog catalog={backups.catalog} loading={backups.loading}
          busy={backups.busy} error={backups.error}
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
          {dirtyDocument && <span className="doc-flag">未保存</span>}
        </div>
        <div className="tb-spacer" />
        <div className="tb-group">
          <button type="button" className="btn" disabled={busy} onClick={onDock}>
            <IconDock />停靠到主窗口
          </button>
        </div>
      </header>
      <div className="editor-panel float">
        <EditorPanel hasDocument={!!current} input={input} controller={controller}
          onRetryBegin={() => { controller.retry(); setBeginNonce(value => value + 1); }} />
      </div>
      <div className="changes-panel float">
        <ReviewPanel changes={changes} reviewed={effectiveReviewed} pending={reviewStatus.pending} />
      </div>
      <footer className="statusbar">
        <span className="st-item" role="status">
          {inputView.composing && '组词中'}
          {!inputView.composing && (inputView.busy || inputView.applying) && '正在更新预览…'}
          {!inputView.composing && !inputView.busy && !inputView.applying && inputView.dirty && '有待预览的输入'}
          {!inputView.composing && !inputView.busy && !inputView.applying && !inputView.dirty
            && (changes.length ? `${changes.length} 条未保存修改` : '无未保存修改')}
        </span>
        <span className="st-spacer" />
        <span className="st-hint">保存在主窗口进行</span>
      </footer>
      {toast && <div className={toast.kind === 'error' ? 'toast toast-error' : 'toast'} role="status">{toast.text}</div>}
    </div>
  );
}
