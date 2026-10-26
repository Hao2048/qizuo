import { useEffect, useState, useRef } from "react";
import type {
  Workbench,
  WorkbenchParticipant,
  WorkbenchReview as Review,
  WorkbenchReviewFile,
} from "@pi-harness/contracts";
import { invoke } from "../api.js";
import { Markdownish } from "../components/Markdown.js";
const nativeDocument=/\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|pages|numbers|key)$/i;
const browserArtifact=/\.(html?|pdf|svg|png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v|mp3|wav|m4a|ogg|md|markdown|txt|csv|tsv|json|jsonl|ya?ml|xml|log|py|[cm]?jsx?|tsx?|css|scss|sql|sh|bash|go|rs|java|c|h|cpp|vue|svelte|toml|ini)$/i;
function previewLabel(path:string){return /\.html?$/i.test(path)?"预览网页 ↗":/\.(mp4|webm|mov|m4v)$/i.test(path)?"播放视频 ↗":/\.(mp3|wav|m4a|ogg)$/i.test(path)?"播放音频 ↗":/\.(png|jpe?g|svg|webp|gif|avif)$/i.test(path)?"查看图片 / 图表 ↗":"查看完整文件 ↗";}
type Action = (fn: () => Promise<unknown>) => Promise<void>;
export function WorkbenchReview({
  w,
  p,
  disabled,
  action,
}: {
  w: Workbench;
  p: WorkbenchParticipant;
  disabled: boolean;
  action: Action;
}) {
  const [review, setReview] = useState<Review | null>(null),
    [file, setFile] = useState<WorkbenchReviewFile | null>(null),
    [ack, setAck] = useState(false),
    [offset, setOffset] = useState(0);
  const [image, setImage] = useState<{ data: string; mimeType: string } | null>(
    null,
  );
  const [loadError,setLoadError] = useState<string | null>(null);
  const generation = useRef(0), fileRequest = useRef(0);
  const available=!!p.taskId && ["done", "awaiting_review", "applied"].includes(p.status);
  useEffect(() => {
    generation.current++;
    setImage(null);
    setReview(null);
    setFile(null);
    setAck(false);
    setOffset(0);
    if(available)load(0);
    return () => {
      generation.current++;
    };
  }, [
    w.id,
    p.taskId,
    available,
    w.phase,
    p.status,
    JSON.stringify(w.contracts),
    JSON.stringify(w.proposals),
    JSON.stringify(p.configuration),
  ]);
  if (!available)
    return null;
  const load = (page = 0) =>
    void (async () => {
      const version = generation.current;
      const loadRequest=++fileRequest.current;
      setLoadError(null);
      try {
      const result = await invoke("workbench:review", {
        id: w.id,
        roleId: p.roleId,
        offset: page,
        limit: 100,
      });
      if (version !== generation.current || loadRequest !== fileRequest.current) return;
      setImage(null);
      setReview(result);
      setOffset(page);
      setFile(null);
      setAck(false);
      const candidates=result.files.filter(f=>f.kind!=="deleted");
      const primary=candidates.find(f=>/(^|\/)(dist|build|delivery)\/.*index\.html?$/i.test(f.path))??candidates.find(f=>/(^|\/)index\.html?$/i.test(f.path))??candidates.find(f=>/\.(mp4|webm|pdf|docx|md|xlsx|svg|png)$/i.test(f.path))??candidates[0];
      if(primary){const request=loadRequest;const next=await invoke("workbench:reviewFile",{id:w.id,roleId:p.roleId,token:result.token,path:primary.path});if(version===generation.current&&request===fileRequest.current)setFile(next);}
      } catch(error) {
        if(version===generation.current && loadRequest===fileRequest.current)setLoadError(error instanceof Error?error.message:String(error));
      }
    })();
  return (
    <div className="wb-review">
      {loadError && <p role="alert">{loadError}</p>}
      <button className="ghost" disabled={disabled} onClick={() => load()}>
        刷新成果文件
      </button>
      {review && (
        <>
          <p className="hint">
            {review.total} 个变更文件 · {review.conflicts}{" "}
            个冲突。对比当前项目与角色成果，确认后应用。
          </p>
          {review.blockedReason && <p role="alert">{review.blockedReason}</p>}
          <div className="wb-review-files">
            {review.files.map((f) => (
              <button
                key={f.path}
                className="ghost"
                disabled={disabled}
                aria-pressed={file?.path === f.path}
                onClick={() =>
                  void action(async () => {
                    const version = generation.current, request=++fileRequest.current;
                    setImage(null);
                    setFile(null);
                    const next = await invoke("workbench:reviewFile", {
                      id: w.id,
                      roleId: p.roleId,
                      token: review.token,
                      path: f.path,
                    });
                    if (version === generation.current && request===fileRequest.current) setFile(next);
                  })
                }
              >
                <span>
                  {(
                    {
                      added: "新增",
                      modified: "修改",
                      deleted: "删除",
                    } as Record<string, string>
                  )[f.kind] ?? f.kind}
                </span>
                <code>{f.path}</code>
                {f.conflict && <strong>{f.reason}</strong>}
              </button>
            ))}
          </div>
          {review.total > 100 && (
            <div>
              <button
                className="ghost"
                disabled={disabled || offset === 0}
                onClick={() => load(offset - 100)}
              >
                上一页文件
              </button>
              <span>
                {offset + 1}–{Math.min(offset + 100, review.total)} /{" "}
                {review.total}
              </span>
              <button
                className="ghost"
                disabled={disabled || offset + 100 >= review.total}
                onClick={() => load(offset + 100)}
              >
                下一页文件
              </button>
            </div>
          )}
          {file && review.files.some(f=>f.path===file.path&&f.kind!=="deleted") && (
            <div className="wb-artifact-actions">
              {browserArtifact.test(file.path)&&<button type="button" className="primary" disabled={disabled} onClick={()=>void action(async()=>{await invoke("workbench:preview",{id:w.id,roleId:p.roleId,token:review.token,path:file.path});})}>{previewLabel(file.path)}</button>}
              {(nativeDocument.test(file.path)||/\.(pdf|mp4|webm|mov|m4v|mp3|wav|m4a|ogg)$/i.test(file.path))&&<button type="button" className="primary" disabled={disabled} onClick={()=>void action(async()=>{await invoke("workbench:openDocument",{id:w.id,roleId:p.roleId,token:review.token,path:file.path});})}>{nativeDocument.test(file.path)?"系统预览文档":"系统预览"}</button>}
              <button type="button" className="ghost" disabled={disabled} onClick={()=>void action(async()=>{await invoke("workbench:preview",{id:w.id,roleId:p.roleId,token:review.token,path:file.path,download:true});})}>下载原文件</button>
              <button type="button" className="ghost" disabled={disabled} onClick={()=>void action(async()=>{await invoke("workbench:revealFile",{id:w.id,roleId:p.roleId,token:review.token,path:file.path});})}>在访达中显示</button>
              <span className="hint">预览不会应用或执行文件。网页为静态预览；Office 文档由系统只读预览。</span>
            </div>
          )}
          {file && /\.(png|jpe?g|webp|gif)$/i.test(file.path) && (
            <div className="wb-image-preview">
              <button
                type="button"
                className="ghost"
                disabled={disabled}
                onClick={() =>
                  void action(async () => {
                    const version = generation.current, request=fileRequest.current;
                    setImage(null);
                    const next = await invoke("workbench:reviewImage", {
                      id: w.id,
                      roleId: p.roleId,
                      token: review.token,
                      path: file.path,
                    });
                    if (version === generation.current && request===fileRequest.current) setImage(next);
                  })
                }
              >
                预览成果图片
              </button>
              {image && (
                <figure>
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={`角色成果：${file.path}`}
                  />
                  <figcaption>图片显示不代表联调或人工验收已通过。</figcaption>
                </figure>
              )}
            </div>
          )}
          {file && !file.after.binary && /\.(md|markdown)$/i.test(file.path) && <section className="wb-document-preview bubble md" aria-label="文档预览"><Markdownish text={file.after.text}/>{file.after.truncated&&<p className="hint">此处为文档前 32 KB，完整内容请打开或下载原文件。</p>}</section>}
          {file && !file.after.binary && !/\.(md|markdown|html?)$/i.test(file.path) && <section className="wb-document-preview" aria-label="代码与数据预览"><h4>{file.path}</h4><pre>{file.after.text}</pre>{file.after.truncated&&<p className="hint">完整内容请打开或下载原文件。</p>}</section>}
          {file && (
            <details className="wb-file-comparison" ><summary>查看源码与变更对比</summary><div className="wb-review-comparison" aria-label="文件内容对比">
              {(
                [
                  ["before", "当前项目"],
                  ["after", "角色成果"],
                ] as const
              ).map(([side, label]) => (
                <section key={side}>
                  <h4>
                    {label}
                    <small>{file[side].bytes} 字节</small>
                  </h4>
                  {file[side].binary ? (
                    <p>二进制或非 UTF-8 文件，内容不作文本展示。</p>
                  ) : (
                    <pre>{file[side].text || "（空文件或不存在）"}</pre>
                  )}
                  {file[side].truncated && (
                    <p className="hint">
                      内容较长，仅展示前 32 KB；请结合完整成果核对后再应用。
                    </p>
                  )}
                </section>
              ))}
            </div></details>
          )}
          {!review.files.length&&<p className="hint">本角色没有新增或修改的文件；请查看该角色的交付说明或执行记录。</p>}
          {p.status !== "applied" && (
            <>
              <label className="wb-review-ack">
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={
                    disabled || !!review.conflicts || !!review.blockedReason
                  }
                  onChange={(e) => setAck(e.target.checked)}
                />
                我已核对变更及影响范围，确认应用这 {review.total} 个文件
              </label>
              <button
                className="primary"
                disabled={
                  disabled ||
                  !ack ||
                  !!review.conflicts ||
                  !!review.blockedReason
                }
                onClick={() =>
                  void action(async () => {
                    try {
                      await invoke("workbench:apply", {
                        id: w.id,
                        roleId: p.roleId,
                        reviewToken: review.token,
                      });
                    } finally {
                      setAck(false);
                      setReview(null);
                      setFile(null);
                    }
                  })
                }
              >
                确认应用成果
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
export function WorkbenchRepair({
  w,
  disabled,
  action,
}: {
  w: Workbench;
  disabled: boolean;
  action: Action;
}) {
  const [roleId, setRole] = useState(""),
    [instructions, setInstructions] = useState("");
  const options = w.participants.filter((p) => p.enabled && p.taskId);
  const recipient = options.some((p) => p.roleId === roleId) ? roleId : "";
  if (w.verification?.status !== "failed") return null;
  const v = w.verification;
  return (
    <section className="wb-repair">
      <h3>交给角色修复</h3>
      <p className="hint">
        只发送失败步骤与限长日志给选定角色，不重跑整项任务。修复成果仍需审阅、应用并重新联调。
      </p>
      <label>
        处理角色
        <select
          aria-label="修复处理角色"
          value={recipient}
          disabled={disabled}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="">选择相关角色</option>
          {options.map((p) => (
            <option key={p.roleId} value={p.roleId}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        补充要求
        <textarea
          aria-label="修复补充要求"
          maxLength={4000}
          disabled={disabled}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      <button
        className="primary"
        disabled={disabled || !recipient}
        onClick={() =>
          void action(async () => {
            await invoke("workbench:repair", {
              id: w.id,
              roleId: recipient,
              requestId: crypto.randomUUID(),
              verificationAt: v.at,
              fingerprint: v.fingerprint,
              instructions,
            });
            setInstructions("");
          })
        }
      >
        发送失败证据并开始修复
      </button>
    </section>
  );
}
