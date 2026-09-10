import type { WorkspaceResult } from '../contracts/workspace-editor.ts';

export type SaveVerdictKind = 'saved' | 'unchanged' | 'cancelled' | 'rebase-required' | 'unknown' | 'failed';

export type SaveVerdict = Readonly<{
  kind: SaveVerdictKind;
  code: string | null;
  cleanupPending: boolean;
}>;

/**
 * Classify a Save reply against the exact document it targeted.
 *
 * A reply only settles this save when it is bound to this request
 * (result.documentId === the requested documentId) and the connection stayed
 * alive: a preload EDITOR_DISCONNECTED failure carries the cached state, so an
 * old lastSave report — even for the same document — can never prove this save
 * was not committed. Those cases are 'unknown', never 'failed'.
 *
 * Main installs the fresh mapping before reporting a successful Save, so a
 * successful report may carry the new current.id instead of the request id.
 * Only the verified success branch (exact outcome saved/backup-restored) may
 * read cleanupPending from such a new-document report; failed/cancelled and
 * every other report stays bound to the requested id alone. An ok reply
 * without a recognizable outcome or attributable report is unconfirmed.
 */
export function classifySaveResult(result: WorkspaceResult, documentId: string): SaveVerdict {
  // 断连或回复不属于本次请求：缓存/旧状态不能证明本次保存的结果。
  if (result.documentId !== documentId || result.code === 'EDITOR_DISCONNECTED') {
    return { kind: 'unknown', code: result.code ?? null, cleanupPending: false };
  }
  const report = result.state?.lastSave ?? null;
  const currentId = result.state?.current?.id ?? null;
  const authoritative = report && report.documentId === documentId ? report : null;
  const code = result.code ?? authoritative?.code ?? null;
  if (result.ok && (result.outcome === 'saved' || result.outcome === 'backup-restored')) {
    // 成功保存后新基线的报告才允许按新 current.id 归属，仅用于清理警告。
    const fresh = report && report.documentId === currentId && currentId !== documentId
      && (report.status === 'saved' || report.status === 'unchanged') ? report : null;
    return { kind: 'saved', code, cleanupPending: !!(authoritative?.cleanupPending ?? fresh?.cleanupPending ?? result.state?.cleanupPending) };
  }
  if (result.ok && (result.outcome === 'unchanged' || authoritative?.status === 'unchanged')) {
    return { kind: 'unchanged', code, cleanupPending: false };
  }
  if (result.outcome === 'cancelled' || authoritative?.status === 'cancelled') {
    return { kind: 'cancelled', code, cleanupPending: false };
  }
  if (result.outcome === 'rebase-required' || authoritative?.status === 'rebase-required') {
    return { kind: 'rebase-required', code, cleanupPending: authoritative?.cleanupPending ?? false };
  }
  if (authoritative?.status === 'unknown') {
    return { kind: 'unknown', code, cleanupPending: authoritative.cleanupPending };
  }
  if (authoritative?.status === 'failed') {
    // 归属本次保存的权威报告确认提交前失败。
    return { kind: 'failed', code, cleanupPending: authoritative.cleanupPending };
  }
  // 无可识别的准确结果或可归属的报告：不能断言写入未提交。
  return { kind: 'unknown', code, cleanupPending: false };
}
