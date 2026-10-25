import { expect, it } from "vitest";
import { InstallOperations, sealInstall, waitForInstall } from "./install-operations.js";

it("protects publication and prevents a duplicate request from replacing the original", async () => {
	const operations = new InstallOperations(); let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const result = operations.run("one", async signal => { sealInstall(signal); await blocked; return "done"; }, () => "cancelled");
	expect(operations.cancel("one")).toBe(false);
	await expect(operations.run("one", async () => "duplicate", () => "cancelled")).rejects.toThrow("重复");
	release(); expect(await result).toBe("done"); expect(operations.cancel("one")).toBe(false);
});

it("shutdown cancels work, waits for cleanup, and rejects new installs", async () => {
	const operations = new InstallOperations(); let cleaned = false;
	const result = operations.run("one", async signal => {
		try { await waitForInstall(new Promise<void>(() => {}), signal); }
		finally { await new Promise(resolve => setTimeout(resolve, 10)); cleaned = true; }
		return "done";
	}, () => "cancelled");
	await operations.shutdown(); expect(cleaned).toBe(true); expect(await result).toBe("cancelled");
	expect(await operations.run("new", async () => "done", () => "cancelled")).toBe("cancelled");
});

it("does not conceal a failed rollback behind a successful cancellation notice", async () => {
	const operations = new InstallOperations();
	const failure = {ok:false,message:"安装失败且自动恢复未完成，已保留目录和恢复记录"};
	const result = operations.run("one", async signal => {
		try { await waitForInstall(new Promise<void>(() => {}), signal); }
		catch { return failure; }
		return {ok:true,message:"done"};
	}, () => ({ok:false,message:"已取消安装"}));
	operations.cancel("one"); expect(await result).toEqual(failure);
});
