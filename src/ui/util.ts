import type { ResourceFailure } from '../contracts/resources.ts';
import type { WorkspaceRecoveryCatalog } from '../contracts/recovery.ts';

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
