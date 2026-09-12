import type { InputSnapshot } from '../contracts/input.ts';
import type { LiveInputView } from './live-input.ts';

/**
 * 草稿冻结：原文件保存返回 unknown、需要审查的 failed，或 committed 后新基线
 * 重建失败时，Main 的 InputSnapshot.phase 回到 idle 而 draftPhase='uncertain'；
 * 文档关闭后 draftPhase='closed'。两种情况下草稿不再接受任何修改，必须按
 * draftPhase 单独冻结输入。canSaveCopy=true 只是“另存草稿”副本授权，绝不解除
 * 这里的输入冻结。draftPhase 的 preparing/applying 是正常实时输入过程，不冻结，
 * 避免每次自动应用抢焦点或截断组词。
 */
export function draftFrozen(input: InputSnapshot | null): boolean {
  return input !== null && (input.draftPhase === 'uncertain' || input.draftPhase === 'closed');
}

/**
 * 冻结候选另存说明的授权：仅当原文件 Save 结果未确认（uncertain）且 Main 同时
 * 授权 canSaveCopy 时，UI 才能说明"已确认的保存候选可另存为独立副本"。Preview
 * Apply unknown、历史失败或文档关闭的冻结即使同为 uncertain/closed，只要 Main
 * 未授权副本就绝不暗示存在可另存的保存候选；该说明也不表示原文件已保存成功。
 */
export function frozenCopyAvailable(input: InputSnapshot | null): boolean {
  return input !== null && input.draftPhase === 'uncertain' && input.canSaveCopy;
}

/** External transactions and mapping states under which the textarea is quiesced. */
export function quiesced(input: InputSnapshot | null, view: LiveInputView): boolean {
  if (view.flushing || view.resolving) return true;
  // 没有输入会话（只读预览或映射尚未建立）时绝不允许输入：null input 不是写入授权。
  if (!input) return true;
  if (input.mappingStatus !== 'ready') return true;
  if (draftFrozen(input)) return true;
  return input.phase === 'saving' || input.phase === 'leaving' || input.phase === 'closed'
    || input.phase === 'history' || input.phase === 'resolving' || input.phase === 'beginning';
}

/**
 * 冻结且仍有保留内容时，textarea 用 readOnly 保留（同一节点、同一值，可聚焦、
 * 选择、复制），而不是 disabled。保存故障/关闭冻结本身即构成保留理由，即使本地
 * 输入已完全应用；其他冻结沿用原有的未确认/组词/失败判定。
 */
export function preservedText(input: InputSnapshot | null, view: LiveInputView): boolean {
  if (!quiesced(input, view) || view.localText === '') return false;
  return draftFrozen(input) || view.dirty || view.composing || view.phase === 'failed' || view.error !== null;
}
