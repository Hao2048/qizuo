import { useEffect, useState } from "react";
import { invoke } from "../api.js";
import { useStore } from "../store.js";
import { openTask, refreshTaskList } from "../data.js";

/** 分叉对话框：列出会话历史用户消息，从选定消息重开分支（新任务）。 */
export function ForkDialog(): React.ReactElement | null {
	const taskId = useStore((s) => s.currentTaskId);
	const candidates = useStore((s) => s.forkCandidates);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	if (!candidates || !taskId) return null;

	const fork = async (entryId: string) => {
		setBusy(entryId);
		setError(null);
		try {
			const task = await invoke("task:fork", { taskId, entryId });
			useStore.getState().setForkCandidates(null);
            await openTask(task.id);
            useStore.getState().setPage("workbench");
            await refreshTaskList();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="modal-mask" onClick={(e) => e.target === e.currentTarget && useStore.getState().setForkCandidates(null)}>
			<div className="modal">
				<h2>从历史消息分叉</h2>
				<p className="hint">选择一条用户消息：保留该轮次的指令、回复与工具结果，创建新会话。等待你的下一条消息，不会自动重做历史任务（原任务保留）。</p>
				<div className="fork-list">
					{candidates.map((c) => (
						<button type="button" key={c.entryId} className="fork-item" disabled={busy !== null} onClick={() => void fork(c.entryId)}>
							<span className="fork-text">{c.text}</span>
							<span className="hint">{busy === c.entryId ? "分叉中…" : "从此分叉 →"}</span>
						</button>
					))}
				</div>
				{error ? <p className="hint danger">{error}</p> : null}
				<div className="modal-actions">
					<button type="button" className="ghost" onClick={() => useStore.getState().setForkCandidates(null)}>
						取消
					</button>
				</div>
			</div>
		</div>
	);
}

/** 市场每日推荐区（npm 月下载量排序，日缓存），卡片网格式。 */
export function ApprovalPolicySection(): React.ReactElement {
	const settings = useStore((s) => s.settings);
	const [busy, setBusy] = useState(false);
	const allTools = ["read", "grep", "find", "ls", "write", "edit", "bash"];
	const current = settings?.autoApproveTools ?? ["read", "grep", "find", "ls"];

	const toggle = (tool: string) => {
		const next = current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool];
		void (async () => {
			setBusy(true);
			try {
				const s = await invoke("settings:set", {
					defaultModel: settings?.defaultModel ?? null,
					autoApproveTools: next,
					autoMemory: settings?.autoMemory ?? false,
					sandboxMode: settings?.sandboxMode ?? "off",
				});
				useStore.getState().hydrate({ settings: s });
			} finally {
				setBusy(false);
			}
		})();
	};

	return (
		<div>
			<p className="hint">勾选的工具免审批直接执行（对新建任务生效）；未勾选的每次调用弹出审批卡。</p>
			<div className="approval-tools">
				{allTools.map((t) => (
					<label key={t} className={`tool-toggle${current.includes(t) ? " on" : ""}`}>
						<input type="checkbox" checked={current.includes(t)} disabled={busy} onChange={() => toggle(t)} />
						<code>{t}</code>
					</label>
				))}
			</div>
		</div>
	);
}

/** bash 运行沙箱（macOS Seatbelt）：关闭 / 只读 / 工作区可写。 */
export function SandboxSection(): React.ReactElement {
	const settings = useStore((s) => s.settings);
	const current = settings?.sandboxMode ?? "off";
	const MODES = [
		{ id: "off", label: "关闭", desc: "bash 命令全权限执行（仅审批策略管控）" },
		{ id: "read_only", label: "只读", desc: "全盘只读（临时目录可写、网络允许），防误写任意文件" },
		{ id: "workspace_write", label: "工作区可写", desc: "仅任务工作区与临时目录可写，其余只读（推荐）" },
	] as const;

	const choose = (mode: "off" | "read_only" | "workspace_write") => {
		void (async () => {
			const s = await invoke("settings:set", {
				defaultModel: settings?.defaultModel ?? null,
				autoApproveTools: settings?.autoApproveTools ?? ["read", "grep", "find", "ls"],
				autoMemory: settings?.autoMemory ?? false,
				sandboxMode: mode,
			});
			useStore.getState().hydrate({ settings: s });
		})();
	};

	return (
		<div>
			<p className="hint">
				macOS 系统级沙箱（sandbox-exec）约束 bash 工具的命令执行，对新建任务生效；
				write/edit 工具不经 shell，仍由工具权限与审批管控。项目修改可在 Git 面板查看。
			</p>
			<div className="approval-tools">
				{MODES.map((m) => (
					<button key={m.id} type="button" className={`tool-toggle${current === m.id ? " on" : ""}`} title={m.desc} onClick={() => choose(m.id)}>
						<code>{m.label}</code>
					</button>
				))}
			</div>
			<p className="hint">{MODES.find((m) => m.id === current)?.desc}</p>
		</div>
	);
}
