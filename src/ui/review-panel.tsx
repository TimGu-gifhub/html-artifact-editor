import { useEffect, useRef } from 'react';
import { requestReview, requestReviewAll } from './review-channel.ts';

type ChangeEntry = Readonly<{ nodeId: string; oldText: string; newText: string }>;

type ReviewPanelProps = Readonly<{
  changes: readonly ChangeEntry[];
  /** Effective set to display (local intent while a request is pending). */
  reviewed: readonly string[];
  pending: boolean;
  /** 脚本只读预览：没有变更可复核，展示真实原因而不是“没有修改”。 */
  readonly?: boolean;
}>;

/** 复核列表：逐条勾选当前净变更，全选只作用于当前全部条目。 */
export function ReviewPanel(props: ReviewPanelProps) {
  const reviewed = new Set(props.reviewed);
  const all = props.changes.length > 0 && props.changes.every(change => reviewed.has(change.nodeId));
  const some = props.changes.some(change => reviewed.has(change.nodeId));
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = some && !all;
  }, [some, all]);

  return (
    <div className="changes-inner">
      <div className="panel-head">
        <h2>复核变更 <span className={props.changes.length ? 'count has' : 'count'}>{props.changes.length}</span></h2>
        {props.pending && <span className="hint">正在记录复核状态…</span>}
        {props.changes.length > 0 && <label className="check-all">
          <input
            ref={allRef}
            type="checkbox"
            checked={all}
            onChange={event => requestReviewAll(event.target.checked)}
          />
          全选
        </label>}
      </div>
      <div className="changes-list">
        {props.changes.length === 0 && <div className="changes-empty">
          {props.readonly ? <>
            <p>脚本只读预览不跟踪文字修改。</p>
            <p>返回静态校稿后，修改会在此列出；全部勾选复核后才能保存。</p>
          </> : <>
            <p>当前没有未保存的修改。</p>
            <p>保存前需要在此勾选全部变更；再次修改某条会自动取消其勾选。</p>
          </>}
        </div>}
        {props.changes.map(change => (
          <div className="change-item" key={change.nodeId}>
            <label className="ci-head">
              <input
                type="checkbox"
                checked={reviewed.has(change.nodeId)}
                onChange={event => requestReview(change.nodeId, event.target.checked)}
              />
              已复核
            </label>
            <div className="ci-diff">
              <span className="ci-old">{change.oldText || '（空）'}</span>
              <span className="ci-new">{change.newText || '（空）'}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="changes-foot">{props.readonly
        ? '只读预览下复核与保存已停用；返回静态校稿后恢复。'
        : '勾选表示你已核对这条“原文 → 新文”。全部勾选后才能保存。'}</div>
    </div>
  );
}
