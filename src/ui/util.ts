import type { ResourceFailure } from '../contracts/resources.ts';
import type { WorkspaceRecoveryCatalog } from '../contracts/recovery.ts';
import type { PresentationState } from '../contracts/desktop.ts';
import type { WorkspaceSnapshot } from '../contracts/workspace.ts';

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} 字节`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
}

export function describeCode(code: string | null): string {
  switch (code) {
    case null: return '操作未完成。';
    case 'EDITOR_DISCONNECTED': return '与主进程的连接已断开。未发送的输入已保留在输入框中，可复制保存；请勿强行关闭窗口，以免丢失未确认的内容。';
    case 'INVALID_WORKSPACE_REQUEST':
    case 'INVALID_EDITOR_REQUEST': return '请求无效。';
    case 'REVIEW_REQUIRED': return '保存需要先勾选全部复核条目。';
    case 'READ_ONLY_MODE': return '脚本只读预览下不能编辑、保存或恢复；请先返回静态校稿。';
    case 'PREVIEW_MODE_UNAVAILABLE': return '当前平台不支持脚本只读预览。';
    case 'INPUT_COMPOSING': return '正在组词，请先完成当前输入。';
    case 'UNAPPLIED_INPUT': return '有尚未预览的输入，请先完成当前输入。';
    case 'INPUT_FLUSH_REQUIRED': return '有尚未完成的输入，请先完成当前输入。';
    default: return `操作未完成（代码：${code}）。`;
  }
}

export function resourceReasonText(reason: ResourceFailure): string {
  switch (reason) {
    case 'RESOURCE_BLOCKED': return '被安全策略阻断';
    case 'RESOURCE_MISSING': return '文件缺失';
    case 'RESOURCE_LIMIT': return '超出大小限制';
    case 'RESOURCE_CHANGED': return '加载期间内容发生变化';
    case 'RESOURCE_READ_FAILED': return '读取失败';
    case 'RESOURCE_LOAD_FAILED': return '加载失败';
    case 'CSP_BLOCKED': return '被内容安全策略阻断';
  }
}

type RecoveryStatus = WorkspaceRecoveryCatalog['entries'][number]['status'];

export function recoveryStatusText(status: RecoveryStatus): string {
  switch (status) {
    case 'dirty': return '有未保存的修改';
    case 'clean': return '无未保存修改';
    case 'saved': return '已保存，记录待确认';
    case 'retired': return '已结束的会话';
    case 'incomplete': return '记录不完整';
    case 'invalid': return '记录无效';
    case 'ambiguous': return '记录需人工检查';
  }
}

export function recoveryRestorable(status: RecoveryStatus): boolean {
  return status === 'dirty' || status === 'clean' || status === 'saved';
}

/**
 * Main 经整树源码核验的当前显示保留状态（预置正文显隐、渐显效果与 details 展开），
 * 仅当字段属于当前文档且处于静态校稿时可信；缺失字段、异文档或脚本只读预览一律不显示。
 * 该状态只描述屏幕显示，不构成任何文字修改授权，也不得暴露内部源码路径或 offset。
 */
export function presentationForCurrent(state: WorkspaceSnapshot | null): PresentationState | null {
  const current = state?.current;
  const presentation = state?.desktop?.presentation;
  if (!current || current.mode !== 'proofread' || !presentation || presentation.documentId !== current.id) return null;
  return presentation;
}

/** 状态栏反馈文案；无任何保留内容且完整时无需提示，返回 null。 */
export function presentationStatusText(presentation: PresentationState): string | null {
  if (presentation.status === 'partial') {
    return '部分显示未能保留（脚本生成或改写的内容暂不支持）；可返回浏览模式定位这些内容。';
  }
  const parts: string[] = [];
  if (presentation.panels > 0) parts.push(`${presentation.panels} 组预置正文的显隐`);
  const elements = presentation.elements ?? 0;
  if (elements > 0) {
    const details = presentation.details ?? 0;
    parts.push(details > 0
      ? `${elements} 处渐显/显隐差异（含 ${details} 个已展开的问答）`
      : `${elements} 处渐显/显隐差异`);
  }
  return parts.length > 0 ? `已保留当前显示：${parts.join('，')}。仅屏幕显示，不写入文件。` : null;
}
