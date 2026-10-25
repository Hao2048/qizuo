import { invoke } from "../api.js";
import { useStore } from "../store.js";

/** 订阅登录弹窗：url / device_code / prompt / info / progress / done / error 全流程。 */
export function LoginModal(): React.ReactElement | null {
	const loginEvent = useStore((s) => s.loginEvent);
	if (!loginEvent) return null;

	if (loginEvent.kind === "done" || loginEvent.kind === "error") {
		const dismiss = () => useStore.getState().setLoginEvent(null);
		return (
			<div className="modal-mask" onClick={(e) => e.target === e.currentTarget && dismiss()}>
				<div className="modal small login-modal">
					<h2>{loginEvent.kind === "done" ? "登录成功" : "登录失败"}</h2>
					<p className={loginEvent.kind === "done" ? "hint ok" : "hint danger"}>{loginEvent.message}</p>
					<div className="modal-actions">
						<button type="button" className="primary" onClick={dismiss}>
							关闭
						</button>
					</div>
				</div>
			</div>
		);
	}

	const answer = async (value: string) => {
		await invoke("model:loginAnswer", { flowId: loginEvent.flowId, answer: value }).catch(() => {});
	};
	const cancel = async () => {
		await invoke("model:loginCancel", { flowId: loginEvent.flowId }).catch(() => {});
		useStore.getState().setLoginEvent(null);
	};

	return (
		<div className="modal-mask">
			<div className="modal small login-modal">
				<h2>订阅登录</h2>
				{loginEvent.kind === "url" ? (
					<div>
						<p className="hint">已在浏览器打开授权页面；如未打开请点击：</p>
						<button type="button" className="primary" onClick={() => window.open(loginEvent.url, "_blank")}>
							打开授权页面
						</button>
					</div>
				) : null}
				{loginEvent.kind === "device_code" ? (
					<div>
						<p className="hint">请在打开的页面输入以下代码完成授权：</p>
						<div className="device-code">{loginEvent.userCode}</div>
						<p className="hint">
							手动打开：
							<a
								href={loginEvent.verificationUri}
								onClick={(e) => {
									e.preventDefault();
									window.open(loginEvent.verificationUri, "_blank");
								}}
							>
								{loginEvent.verificationUri}
							</a>
						</p>
					</div>
				) : null}
				{loginEvent.kind === "prompt" ? (
					<div>
						<p className="hint">{loginEvent.promptText}</p>
						<div className="login-options">
							{(loginEvent.options ?? []).map((o) => (
								<button key={o.id} type="button" className="ghost block" onClick={() => void answer(o.id)}>
									{o.label}
								</button>
							))}
						</div>
					</div>
				) : null}
				{loginEvent.kind === "info" || loginEvent.kind === "progress" ? (
					<p className="hint">{loginEvent.message}</p>
				) : null}
				<div className="modal-actions">
					<button type="button" className="ghost" onClick={() => void cancel()}>
						取消登录
					</button>
				</div>
			</div>
		</div>
	);
}
