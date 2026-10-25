import { useStore } from "../store.js";

/** A passive, collapsed receipt. It offers no automatic continuation or permission grant. */
export default function CompletionNotice(): React.ReactElement | null {
  const taskId = useStore(s => s.currentTaskId);
  const status = useStore(s => s.taskStatus);
  const completion = useStore(s => s.completion);
  if (status !== "done" || completion?.outcome !== "needs_attention") return null;
  return <details className="completion-check" key={`${taskId}:${completion.checkedAt}`}>
    <summary>本轮回复已结束 · 有 {completion.issues.length} 项需要核对</summary>
    <ul>{completion.issues.map(issue => <li key={issue.code}>{issue.message}</li>)}</ul>
    <p>这是本地执行记录检查，不能代替成果验收。不会自动继续任务或重跑操作。</p>
  </details>;
}
