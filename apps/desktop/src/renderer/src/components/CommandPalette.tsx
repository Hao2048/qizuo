import { useEffect, useMemo, useState } from "react";
import { invoke } from "../api.js";
import { openTask } from "../data.js";
import { useStore, type PageId } from "../store.js";

interface Action {
	id: string;
	label: string;
	hint?: string;
	run: () => void | Promise<void>;
}

/** 命令面板（⌘K）：导航/任务/动作快捷入口。 */
export function CommandPalette(): React.ReactElement | null {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const page = useStore((s) => s.page);
	const tasks = useStore((s) => s.tasks);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setOpen((o) => !o);
				setQuery("");
			}
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const runExport = async (format: "markdown" | "json" | "html"): Promise<void> => {
		const taskId = useStore.getState().currentTaskId;
		if (!taskId) return;
		const r = await invoke("export:transcript", { taskId, format }).catch(() => null);
		useStore.getState().setNotice(
			r?.ok ? { level: "info", message: `已导出：${r.path}` } : { level: "warn", message: "未导出（已取消或任务为空）" },
		);
	};

	const actions = useMemo<Action[]>(() => {
		const nav = (p: PageId, label: string): Action => ({
			id: `nav-${p}`,
			label,
			hint: "导航",
			run: () => useStore.getState().setPage(p),
		});
		const list: Action[] = [
			{ id: "new-task", label: "新任务", hint: "工作台", run: () => {
				useStore.getState().selectTask(null);
				useStore.getState().resetConversation();
				useStore.getState().setPage("workbench");
			} },
			nav("workbench", "前往 工作台"),
			nav("roles", "前往 角色卡"),
			nav("memory", "前往 长期记忆"),
			nav("market", "前往 Skill 与插件"),
			nav("settings", "前往 模型与设置"),
			{ id: "export", label: "导出当前任务为 Markdown", hint: "动作", run: () => runExport("markdown") },
			{ id: "export-json", label: "导出当前任务为 JSON", hint: "动作", run: () => runExport("json") },
			{ id: "export-html", label: "导出当前任务为 HTML", hint: "动作", run: () => runExport("html") },
			{ id: "diag", label: "导出诊断信息", hint: "动作", run: async () => {
				const r = await invoke("diag:export", {}).catch(() => null);
				if (r?.ok) useStore.getState().setNotice({ level: "info", message: `诊断目录：${r.path}` });
			} },
			{ id: "selfcheck", label: "运行系统自检", hint: "动作", run: async () => {
				await invoke("health:get", {}).catch(() => null);
				useStore.getState().setPage("settings");
			} },
		];
		for (const t of tasks.slice(0, 30)) {
			list.push({
				id: `task-${t.id}`,
				label: `打开任务：${t.title}`,
				hint: t.status,
				run: () => {
					useStore.getState().setPage("workbench");
     void openTask(t.id).catch(e=>useStore.getState().setNotice({level:"error",message:e instanceof Error?e.message:String(e)}));
				},
			});
		}
		return list;
	}, [tasks, page]);

	const filtered = query.trim()
		? actions.filter((a) => a.label.toLowerCase().includes(query.trim().toLowerCase()))
		: actions;

	if (!open) return null;

	return (
		<div className="palette-mask" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
			<div className="palette">
				<input
					autoFocus
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && filtered[0]) {
							setOpen(false);
							void filtered[0].run();
						}
					}}
					placeholder="输入命令或任务名…（⏎ 执行第一项 / Esc 关闭）"
				/>
				<div className="palette-list">
					{filtered.slice(0, 12).map((a) => (
						<button
							type="button"
							key={a.id}
							className="palette-item"
							onClick={() => {
								setOpen(false);
								void a.run();
							}}
						>
							<span>{a.label}</span>
							{a.hint ? <span className="palette-hint">{a.hint}</span> : null}
						</button>
					))}
					{filtered.length === 0 ? <div className="popover-empty">无匹配命令</div> : null}
				</div>
			</div>
		</div>
	);
}
