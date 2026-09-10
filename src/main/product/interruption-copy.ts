import type { InterruptionSummary } from '../../contracts/interruption.ts';

// Pure product copy for the Main-owned native interruption dialogs. No
// platform calls, IPC, grants, callbacks or file operations live here; Main
// pins the native default button to cancel and binds the exact reviewId, so
// this text can never change behavior.

export const interruptionPickerTitle: string = '检查上次中断：选择原 HTML 文件';

const saveObservationDetail = (summary: Extract<InterruptionSummary, Readonly<{ kind: 'save' }>>): string => {
  switch (summary.observed) {
    case 'baseline-matches':
      return `当前文件仍是保存前的版本，中断的修改没有写入。确认只保留当前文件、记录本次核验并移除旧的中断标记；不会重放旧草稿，也不代表上次保存成功。`;
    case 'committed-matches':
      return `完整的已提交证据与当前文件一致，上次修改已在文件中。确认只记录本次核验并移除旧的中断标记；不会再次写入文件。`;
    case 'candidate-on-disk':
      return `磁盘上的内容与上次准备写入的候选一致。确认只保留当前文件并移除旧的中断标记；这不代表上次保存成功，也不会重放旧草稿。`;
    case 'conflict':
      return `当前文件与保存前版本、已提交证据都不一致，可能被其他程序修改。确认只保留当前文件并移除旧的中断标记；这不代表上次保存成功，也不会重放旧草稿。`;
  }
};

export function interruptionPrompt(summary: InterruptionSummary): Readonly<{ title: string; message: string; detail: string; cancel: string; confirm: string }> {
  if (summary.kind === 'save') {
    return Object.freeze({
      title: '完成保存中断检查',
      message: `上次保存 ${summary.name} 时被中断。`,
      detail: saveObservationDetail(summary),
      cancel: '取消',
      confirm: '保留当前文件并完成检查',
    });
  }
  return Object.freeze({
    title: '继续清理旧记录',
    message: `上次清理 ${summary.name} 的旧草稿记录时被中断。`,
    detail: `确认只会继续清理严格匹配的 ${summary.obsoleteCount} 个旧记录，保留两份最新完整点、其他会话与全部备份；不会修改 HTML 文件，也不代表有新修改已保存。`,
    cancel: '取消',
    confirm: '确认继续清理旧记录',
  });
}
