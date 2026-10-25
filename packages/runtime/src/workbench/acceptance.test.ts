import { beforeEach, afterEach, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHarnessCore, type HarnessCore } from "../core/harness-core.js";
import { ensureFauxRegistered, fauxModelRef } from "../pi/faux-provider.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
let core: HarnessCore, dir: string, front: string, back: string;
async function call(name: string, input: unknown = {}): Promise<any> {
  const r = await core.router.invoke(name, input);
  if (!r.ok) throw Error(r.error.message);
  return r.result;
}
async function phase(id: string, name: string) {
  for (let i = 0; i < 500; i++) {
    const w = core.workbench.get(id);
    if (w.phase === name) return w;
    if (w.phase === "error" && name !== "error")
      throw Error(w.messages.at(-1)?.text);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("timeout " + name);
}
const json = (obj: unknown) => fauxAssistantMessage(JSON.stringify(obj));
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pih-acceptance-"));
  core = await createHarnessCore({ dataDir: dir, enableFaux: true });
  await call("settings:set", {
    defaultModel: fauxModelRef(),
    permissionMode: "bypass",
    autoApproveTools: [],
  });
  front = (
    await call("role:create", {
      name: "前端",
      preferredModel: fauxModelRef("a"),
    })
  ).id;
  back = (
    await call("role:create", {
      name: "后端",
      preferredModel: fauxModelRef("b"),
    })
  ).id;
});
afterEach(async () => {
  await core.shutdown();
  rmSync(dir, { recursive: true, force: true });
});
async function conversation() {
  ensureFauxRegistered("a").setResponses([
    fauxAssistantMessage("PRIVATE_REPLY_NOT_TRANSFERRED"),
  ]);
  const t = await call("task:create", { roleId: front, title: "官网讨论" });
  await call("task:prompt", { taskId: t.id, text: "PRIVATE_USER_HISTORY" });
  for (let i = 0; i < 300; i++) {
    const r = await call("task:get", { taskId: t.id });
    if (r.task.status === "done")
      return {
        task: t,
        entryId: r.transcript.find(
          (m: any) => m.role === "assistant" && m.entryId,
        ).entryId,
      };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("source timeout");
}
it("普通对话仅交接用户确认的摘要，不复制私有历史、工具或权限，也不自动运行", async () => {
  const { task, entryId } = await conversation(),
    before = await core.tasks.listTasks();
  const input = {
    taskId: task.id,
    entryId,
    requestId: "handoff",
    title: "新官网",
    summary: "已完成界面讨论，后续请实现前后端。",
    roleIds: [front, back],
    confirmed: true,
  };
  const w = await call("workbench:fromConversation", input);
  expect(w.phase).toBe("draft");
  expect(w.participants.every((p: any) => !p.taskId)).toBe(true);
  expect(w.access).toBeUndefined();
  expect(w.conversationOrigin.summary).toBe(input.summary);
  expect(JSON.stringify(w)).not.toContain("PRIVATE_");
  expect(await core.tasks.listTasks()).toHaveLength(before.length);
  expect((await call("task:get", { taskId: task.id })).task.status).toBe(
    "done",
  );
  expect(
    (await call("workbench:list", {})).items.find((x: any) => x.id === w.id)
      .conversationOrigin,
  ).toBeUndefined();
  const again = await Promise.all([
    call("workbench:fromConversation", input),
    call("workbench:fromConversation", input),
  ]);
  expect(again.map((x) => x.id)).toEqual([w.id, w.id]);
  await expect(
    call("workbench:fromConversation", { ...input, summary: "changed" }),
  ).rejects.toThrow("已使用");
});
it("首次并发转入也只创建一个草稿；无效回复、归档角色或未确认不会遗留任务", async () => {
  const { task, entryId } = await conversation(),
    input = {
      taskId: task.id,
      entryId,
      requestId: "concurrent",
      title: "项目",
      summary: "经过确认的交接",
      roleIds: [front],
      confirmed: true,
    };
  const result = await Promise.all([
    call("workbench:fromConversation", input),
    call("workbench:fromConversation", input),
  ]);
  expect(result[0].id).toBe(result[1].id);
  const count = core.workbench.listPage({}).items.length;
  await expect(
    call("workbench:fromConversation", {
      ...input,
      requestId: "wrong",
      entryId: "foreign",
    }),
  ).rejects.toThrow("回复");
  await expect(
    call("workbench:fromConversation", {
      ...input,
      requestId: "unconfirmed",
      confirmed: false,
    }),
  ).rejects.toThrow();
  await call("role:archive", { roleId: front, archived: true });
  await expect(
    call("workbench:fromConversation", { ...input, requestId: "archived" }),
  ).rejects.toThrow("有效");
  expect(core.workbench.listPage({}).items.length).toBe(count);
});
it.skipIf(process.platform !== "darwin")(
  "前后端独立执行、按依赖交接、应用后真实命令验收，局部返修不唤醒无关角色",
  async () => {
    const project = join(dir, "website");
    mkdirSync(project);
    const p = await call("project:add", { dir: project });
    const w = await call("workbench:create", {
      title: "联系表单",
      projectId: p.id,
      roleIds: [front, back],
    });
    const frontend =
      "export function submit(phone){ return {phone:phone.trim()}; }";
    const backend =
      'export function save(body){ if(!/^1[0-9]{10}$/.test(body.phone)) throw Error("invalid phone"); return {saved:true,phone:body.phone}; }';
    const verify =
      'import assert from "node:assert/strict"; import {submit} from "./frontend.mjs"; import {save} from "./backend.mjs"; assert.deepEqual(save(submit(" 13800138000 ")),{saved:true,phone:"13800138000"}); assert.throws(()=>save(submit("bad"))); console.log("phone-flow-passed");';
    let backendCalls = 0;
    ensureFauxRegistered().setResponses([
      json({
        reply: "前端负责表单，后端负责保存与测试",
        action: "dispatch",
        roleIds: [front, back],
        assignments: [
          {
            roleId: front,
            instructions: "实现表单输出phone",
            files: ["frontend.mjs"],
            dependsOn: [],
          },
          {
            roleId: back,
            instructions: "读取前端输出，实现保存和联调测试",
            files: ["backend.mjs", "verify.mjs"],
            dependsOn: [front],
          },
        ],
      }),
    ]);
    ensureFauxRegistered("a").setResponses([
      json({
        plan: "表单phone字段",
        contracts: [
          {
            id: "phone",
            title: "手机号契约",
            content: "输入输出均为phone字符串",
            roles: [front, back],
          },
        ],
      }),
      fauxAssistantMessage([
        fauxToolCall("write", { path: "frontend.mjs", content: frontend }),
      ]),
      fauxAssistantMessage("前端完成"),
    ]);
    ensureFauxRegistered("b").setResponses([
      json({
        plan: "保存并测试",
        contracts: [
          {
            id: "phone",
            title: "手机号契约",
            content: "输入输出均为phone字符串",
            roles: [front, back],
          },
        ],
      }),
      (ctx) => {
        backendCalls++;
        expect(JSON.stringify(ctx)).toContain("phone");
        return fauxAssistantMessage([
          fauxToolCall("read", { path: "frontend.mjs" }),
        ]);
      },
      fauxAssistantMessage([
        fauxToolCall("write", {
          path: "backend.mjs",
          content: backend.replace(
            'throw Error("invalid phone")',
            "return {saved:true,phone:body.phone}",
          ),
        }),
        fauxToolCall("write", { path: "verify.mjs", content: verify }),
      ]),
      fauxAssistantMessage("后端完成"),
    ]);
    await call("workbench:send", {
      id: w.id,
      text: "增加手机号并保存，验证前后端连通",
      requestId: "initial",
    });
    const ready = await phase(w.id, "awaiting_review");
    expect(
      ready.participants.every((p) =>
        ["done", "awaiting_review"].includes(p.status),
      ),
      JSON.stringify(ready),
    ).toBe(true);
    expect(backendCalls).toBe(1);
    for (const roleId of [front, back]) {
      const review = await call("workbench:review", { id: w.id, roleId });
      await call("workbench:apply", {
        id: w.id,
        roleId,
        reviewToken: review.token,
      });
    }
    expect(readFileSync(join(project, "frontend.mjs"), "utf8")).toBe(frontend);
    await call("workbench:verify", {
      id: w.id,
      commands: ["node verify.mjs"],
      network: false,
    });
    for (
      let i = 0;
      i < 400 && core.workbench.get(w.id).verification?.status === "running";
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    const failed = core.workbench.get(w.id);
    expect(
      failed.verification?.status,
      JSON.stringify(failed.verification),
    ).toBe("failed");
    await expect(
      call("workbench:finish", {
        id: w.id,
        evidence: "不能将失败当作通过",
        memoryIds: [],
      }),
    ).rejects.toThrow("联调");
    ensureFauxRegistered().setResponses([
      json({
        reply: "仅由后端修复失败项",
        action: "dispatch",
        roleIds: [back],
        assignments: [
          {
            roleId: back,
            instructions: "修复保存校验",
            files: ["backend.mjs", "verify.mjs"],
            dependsOn: [],
          },
        ],
      }),
    ]);
    const frontTask = failed.participants.find(
      (p) => p.roleId === front,
    )!.taskId;
    ensureFauxRegistered("b").setResponses([
      (ctx) => {
        backendCalls++;
        return json({ plan: "只修复保存校验", contracts: [] });
      },
      fauxAssistantMessage([
        fauxToolCall("write", { path: "backend.mjs", content: backend }),
      ]),
      fauxAssistantMessage("已修复后端，等待重新验收"),
    ]);
    await call("workbench:repair", {
      id: w.id,
      roleId: back,
      requestId: "repair",
      verificationAt: failed.verification!.at,
      fingerprint: failed.verification!.fingerprint,
      instructions: "修复非法手机号仍被保存的问题",
    });
    await phase(w.id, "awaiting_review");
    expect(
      core.workbench.get(w.id).participants.find((p) => p.roleId === front)!
        .taskId,
    ).toBe(frontTask);
    const repaired = await call("workbench:review", { id: w.id, roleId: back });
    await call("workbench:apply", {
      id: w.id,
      roleId: back,
      reviewToken: repaired.token,
    });
    await call("workbench:verify", {
      id: w.id,
      commands: ["node verify.mjs"],
      network: false,
    });
    for (
      let i = 0;
      i < 400 && core.workbench.get(w.id).verification?.status === "running";
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    const result = core.workbench.get(w.id);
    expect(
      result.verification?.status,
      JSON.stringify(result.verification),
    ).toBe("passed");
    expect(result.verification?.steps[0]?.output).toContain(
      "phone-flow-passed",
    );
    await call("workbench:finish", {
      id: w.id,
      evidence: "真实命令验证手机号提交与保存，非法号码被拒绝",
      memoryIds: [],
    });
    ensureFauxRegistered().setResponses([
      json({ reply: "网站已交付，之前的联调仍然通过，本轮仅回顾。", action: "clarify", roleIds: [], assignments: [] }),
    ]);
    await call("workbench:send", { id: w.id, text: "之前做了什么？只回顾。", requestId: "delivered-history" });
    const recalled = await phase(w.id, "done");
    expect(recalled.verification).toEqual(result.verification);
    expect(recalled.participants.map((p) => p.taskId)).toEqual(result.participants.map((p) => p.taskId));
    await call("workbench:setEnabled", { id: w.id, roleId: back, enabled: false });
    ensureFauxRegistered().setResponses([
      json({
        reply: "仅调整前端提示，不涉及保存接口",
        action: "dispatch",
        roleIds: [front],
        assignments: [
          {
            roleId: front,
            instructions: "补充前端说明",
            files: ["frontend.mjs"],
            dependsOn: [],
          },
        ],
      }),
    ]);
    ensureFauxRegistered("a").setResponses([
      json({ plan: "局部说明", contracts: [] }),
      fauxAssistantMessage([
        fauxToolCall("write", {
          path: "frontend.mjs",
          content: frontend + "\n// 已补充说明",
        }),
      ]),
      fauxAssistantMessage("局部修改完成"),
    ]);
    await call("workbench:send", {
      id: w.id,
      text: "只改前端的填写提示，不改后端",
      requestId: "local",
    });
    await phase(w.id, "awaiting_review");
    expect(core.workbench.get(w.id).verification?.status).toBe("stale");
    expect(backendCalls).toBe(2);
    expect(readFileSync(join(project, "backend.mjs"), "utf8")).toBe(backend);
    expect(core.workbench.get(w.id).participants.find((p) => p.roleId === back)).toMatchObject({ enabled: false, status: "applied" });
    const localReview = await call("workbench:review", { id: w.id, roleId: front });
    await call("workbench:apply", { id: w.id, roleId: front, reviewToken: localReview.token });
    await call("workbench:verify", { id: w.id, commands: ["node verify.mjs"], network: false });
    for (let i = 0; i < 400 && core.workbench.get(w.id).verification?.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(core.workbench.get(w.id).verification?.status).toBe("passed");
    await call("workbench:finish", { id: w.id, evidence: "暂停无关角色后局部修改仍可联调交付", memoryIds: [] });
    expect(backendCalls).toBe(2);
    const legacyPause = core.workbench.get(w.id);
    legacyPause.participants.find((p) => p.roleId === back)!.status = "paused";
    core.db.prepare("UPDATE workbenches SET body=? WHERE id=?").run(JSON.stringify(legacyPause), w.id);
    core.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(legacyPause.participants.find((p) => p.roleId === back)!.taskId);
    const recovered = await call("workbench:setEnabled", { id: w.id, roleId: back, enabled: false });
    expect(recovered.participants.find((p: any) => p.roleId === back)).toMatchObject({ enabled: false, status: "awaiting_review" });
    const oldReview = await call("workbench:review", { id: w.id, roleId: back });
    await call("workbench:apply", { id: w.id, roleId: back, reviewToken: oldReview.token });
    expect(backendCalls).toBe(2);
  },
  20000,
);
