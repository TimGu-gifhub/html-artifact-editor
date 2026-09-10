import type { CleanupSummary } from '../../contracts/record-cleanup.ts';

// Pure product copy for the Main-owned native record-cleanup confirmation. No
// platform calls, IPC, grants, callbacks or file operations live here; Main
// pins the native default button to cancel and binds the exact reviewId, so
// this text can never change behavior.

const formatBytes = (size: number): string => {
  if (size < 1024) return `${size} 字节`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
};

// unsavedDrafts counts private draft records that carry changes; it cannot
// prove those changes are absent from the source file (they may match a
// committed version). When resuming, counts/bytes are the previously
// confirmed ORIGINAL manifest: some listed records may already be deleted,
// and continuing only removes the remaining entries that still verify.
const draftNote = '“含修改的草稿记录”只表示该记录带有改动，其中可能包含尚未保存的修改，也可能已写入源文件。';

export function cleanupPrompt(summary: CleanupSummary): Readonly<{ title: string; message: string; detail: string; cancel: string; confirm: string }> {
  const counts = `共 ${summary.records} 条记录：${summary.sessions} 个校稿会话，其中 ${summary.unsavedDrafts} 份含修改的草稿记录、${summary.backups} 份应用备份，合计 ${formatBytes(summary.bytes)}。`;
  if (summary.resuming) {
    return Object.freeze({
      title: '继续清理本地记录',
      message: '上次已确认清理本地记录，但清理过程被中断。',
      detail: `以下是上次确认时的原始清单，其中部分记录可能已在上次被删除：${counts}确认只会继续删除该清单中仍然存在且核验一致的剩余记录，原清单清理完毕即完成。${draftNote}被删除的记录无法恢复；源 HTML、CSS、PDF 与项目文件不会被修改。`,
      cancel: '取消',
      confirm: '确认继续清理',
    });
  }
  return Object.freeze({
    title: '清理本地记录',
    message: '即将删除本应用在这台电脑上保存的全部本地记录。',
    detail: `${counts}${draftNote}删除后，这些本地草稿、撤销历史与应用备份将无法恢复，以后不能再还原；源 HTML、CSS、PDF 与项目文件不会被修改。`,
    cancel: '取消',
    confirm: '确认清理本地记录',
  });
}
