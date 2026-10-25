import Icon from "../components/Icon.js";
import { useState } from "react";
import type { WorkspaceFileInfo } from "@pi-harness/contracts";
import { formatBytes } from "@pi-harness/shared";
import { invoke } from "../api.js";
import { useStore } from "../store.js";

/** 当前会话工作目录，只读浏览；成果写入使用工作台审阅流程。 */
export function WorkspacePanel(): React.ReactElement | null {
	const taskId = useStore((s) => s.currentTaskId);
	const [open, setOpen] = useState(false);
	const [files, setFiles] = useState<Array<{ relPath: string; sizeBytes: number }>>([]);
	const [message, setMessage] = useState<string | null>(null);

	if (!taskId) return null;
	return (
		<div className="usage-panel">
			<button
				type="button"
				className="chip-btn"
				onClick={() => {
					const next = !open;
					setOpen(next);
					if (next) {
						void invoke("task:getWorkspaceFiles", { taskId })
							.then((r) => setFiles(r.files))
							.catch(() => setFiles([]));
					}
				}}
			>
				<Icon name="folder" size={15}/> 工作区{files.length ? ` · ${files.length}` : ""}
			</button>
			{open ? (
				<div className="usage-table">
					{files.length === 0 ? (
						<p className="hint">当前工作目录没有可展示的文件</p>
					) : (
						files.map((f) => (
							<div key={f.relPath} className="checkpoint-row">
								<span title={f.relPath}>
									{f.relPath} · {formatBytes(f.sizeBytes)}
								</span>
							</div>
						))
					)}
					{message ? <p className="hint">{message}</p> : null}
				</div>
			) : null}
		</div>
	);
}
