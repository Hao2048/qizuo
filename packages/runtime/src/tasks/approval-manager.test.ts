import { describe, expect, it } from "vitest";
import { ApprovalManager } from "./approval-manager.js";
import { composePromptWithAttachments } from "./task-service.js";

describe("ApprovalManager", () => {
	it("创建→决策→resolve", async () => {
		const m = new ApprovalManager();
		const p = m.create({ taskId: "t1", toolCallId: "c1", toolName: "bash", input: { command: "rm" } });
		expect(m.pending()).toHaveLength(1);
		const decided = m.decide("c1", true);
		expect(decided).toBe(true);
		await expect(p).resolves.toEqual({ approved: true, reason: undefined });
		expect(m.pending()).toHaveLength(0);
	});

	it("拒绝带原因；未知 id 决策返回 false", async () => {
		const m = new ApprovalManager();
		const p = m.create({ taskId: "t1", toolCallId: "c1", toolName: "write", input: {} });
		m.decide("c1", false, "危险操作");
		await expect(p).resolves.toEqual({ approved: false, reason: "危险操作" });
		expect(m.decide("missing", true)).toBe(false);
	});

	it("rejectAll：全部按拒绝清理", async () => {
		const m = new ApprovalManager();
		const p1 = m.create({ taskId: "t", toolCallId: "a", toolName: "bash", input: {} });
		const p2 = m.create({ taskId: "t", toolCallId: "b", toolName: "write", input: {} });
		const n = m.rejectAll("任务已停止");
		expect(n).toBe(2);
		await expect(p1).resolves.toMatchObject({ approved: false });
		await expect(p2).resolves.toMatchObject({ approved: false });
		expect(m.pending()).toHaveLength(0);
	});

	it("重复 toolCallId 防御性拒绝", async () => {
		const m = new ApprovalManager();
		m.create({ taskId: "t", toolCallId: "dup", toolName: "bash", input: {} });
		await expect(
			m.create({ taskId: "t", toolCallId: "dup", toolName: "bash", input: {} }),
		).resolves.toMatchObject({ approved: false });
	});
});

describe("composePromptWithAttachments", () => {
	it("无文本附件原样返回", () => {
		expect(composePromptWithAttachments("hello", [{ kind: "image", name: "a.png" }])).toBe("hello");
	});
	it("文本附件以带名分块追加", () => {
		const out = composePromptWithAttachments("看这个", [
			{ kind: "text", name: "a.ts", path: "/tmp/a.ts", data: "const a = 1;" },
		]);
		expect(out).toContain("看这个");
		expect(out).toContain("a.ts");
		expect(out).toContain("const a = 1;");
	});
});

it("keeps provider-reused call IDs independent across tasks and refuses unscoped ambiguous decisions",async()=>{
 const m=new ApprovalManager();
 const a=m.create({taskId:"a",toolCallId:"provider-call-1",toolName:"write",input:{path:"a.txt"}});
 const b=m.create({taskId:"b",toolCallId:"provider-call-1",toolName:"write",input:{path:"b.txt"}});
 expect(m.pending()).toHaveLength(2);
 expect(m.decide("provider-call-1",true)).toBe(false);
 expect(m.decide("provider-call-1",true,undefined,"other")).toBe(false);
 expect(m.decide("provider-call-1",true,undefined,"a")).toBe(true);await expect(a).resolves.toMatchObject({approved:true});
 expect(m.pending().map(p=>p.taskId)).toEqual(["b"]);m.rejectTask("b","stop b");await expect(b).resolves.toMatchObject({approved:false,reason:"stop b"});
});
