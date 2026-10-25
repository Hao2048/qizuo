import { useState } from "react";
import { invoke } from "../api.js";
import { useStore } from "../store.js";

export function QuestionModal(): React.ReactElement | null {
	const question = useStore((s) => s.question);
	const [other, setOther] = useState("");
	if (!question) return null;

	const answer = async (text: string) => {
		if (!text.trim()) return;
		useStore.getState().setQuestion(null);
		setOther("");
		try {
			await invoke("task:answerQuestion", { taskId: question.taskId, questionId: question.questionId, answer: text.trim() });
		} catch (e) {
			useStore.getState().setNotice({ level: "error", message: e instanceof Error ? e.message : String(e) });
		}
	};

	return (
		<div className="modal-mask">
			<div className="modal small anim-pop">
				<h2>Agent 提问 · 需要你决策</h2>
				<p className="hint">
					<strong>{question.question}</strong>
				</p>
				<div className="question-options">
					{question.options.map((o) => (
						<button key={o.label} type="button" className="ghost block" onClick={() => void answer(o.label)} title={o.description ?? ""}>
							{o.label}
							{o.description ? <span className="hint">{o.description}</span> : null}
						</button>
					))}
				</div>
				<div className="question-other">
					<input value={other} onChange={(e) => setOther(e.target.value)} placeholder="或输入其他答案…" onKeyDown={(e) => e.key === "Enter" && void answer(other)} />
					<button type="button" className="primary sm" disabled={!other.trim()} onClick={() => void answer(other)}>
						提交
					</button>
				</div>
			</div>
		</div>
	);
}
