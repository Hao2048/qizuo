import { beforeEach, afterEach, it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessCore, type HarnessCore } from "../core/harness-core.js";
import { ensureFauxRegistered, fauxModelRef } from "../pi/faux-provider.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
let lastCoordinator = "";
let core: HarnessCore, dir: string, a: string, b: string, c: string;
async function call(name: string, input: unknown = {}): Promise<any> {
  const r = await core.router.invoke(name, input);
  if (!r.ok) throw Error(r.error.message);
  return r.result;
}
const json = (value: unknown) => fauxAssistantMessage(JSON.stringify(value));
async function phase(id: string, phase: string) {
  for (let i = 0; i < 200; i++) {
    const w = core.workbench.get(id);
    if (w.phase === phase) return w;
    if (w.phase === "error" && phase !== "error")
      throw Error(w.messages.at(-1)?.text);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("timeout");
}
function route(roleId: string, files = ["front.txt"]) {
  ensureFauxRegistered().setResponses([
    (ctx) => {
      lastCoordinator = JSON.stringify(ctx);
      return json({
        reply: "明确分工",
        action: "dispatch",
        roleIds: [roleId],
        assignments: [
          { roleId, instructions: "处理页面", files, dependsOn: [] },
        ],
      });
    },
  ]);
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pih-role-change-"));
  core = await createHarnessCore({ dataDir: dir, enableFaux: true });
  await call("settings:set", {
    defaultModel: fauxModelRef(),
    permissionMode: "bypass",
    autoApproveTools: [],
  });
  a = (
    await call("role:create", {
      name: "原前端",
      intro: "OLD_PUBLIC_INTRO",
      systemPrompt: "OLD_PRIVATE_PROMPT",
      preferredModel: fauxModelRef("a"),
    })
  ).id;
  b = (
    await call("role:create", {
      name: "后端",
      preferredModel: fauxModelRef("b"),
    })
  ).id;
  c = (
    await call("role:create", {
      name: "新前端",
      systemPrompt: "NEW_PRIVATE_PROMPT",
      preferredModel: fauxModelRef("c"),
    })
  ).id;
});
afterEach(async () => {
  await core.shutdown();
  rmSync(dir, { recursive: true, force: true });
});
it("freezes planning and execution configuration until a user confirms a fresh preview", async () => {
  const w = await call("workbench:create", { title: "配置", roleIds: [a, b] });
  await call("role:update", {
    roleId: a,
    systemPrompt: "CHANGED_PROMPT",
    intro: "NEW_PUBLIC_INTRO",
    preferredModel: fauxModelRef("c"),
  });
  expect(core.workbench.get(w.id).participants[0]?.configurationChanged).toBe(
    true,
  );
  let plan = "",
    execute = "";
  route(a);
  ensureFauxRegistered("a").setResponses([
    (ctx) => {
      plan = JSON.stringify(ctx);
      return json({ plan: "规划", contracts: [] });
    },
    (ctx) => {
      execute = JSON.stringify(ctx);
      return fauxAssistantMessage("完成");
    },
  ]);
  ensureFauxRegistered("c").setResponses([
    () => {
      throw Error("不应使用新模型");
    },
  ]);
  await call("workbench:send", {
    id: w.id,
    text: "调整页面",
    requestId: "frozen",
  });
  await phase(w.id, "awaiting_review");
  expect(lastCoordinator).not.toContain("OLD_PRIVATE_PROMPT");
  expect(lastCoordinator).not.toContain("CHANGED_PROMPT");
  expect(plan).toContain("OLD_PUBLIC_INTRO");
  expect(plan).not.toContain("NEW_PUBLIC_INTRO");
  expect(plan).not.toContain("OLD_PRIVATE_PROMPT");
  expect(execute).toContain("OLD_PRIVATE_PROMPT");
  expect(execute).not.toContain("CHANGED_PROMPT");
  const preview = await call("workbench:roleChangePreview", {
    id: w.id,
    roleId: a,
  });
  expect(preview.kind).toBe("sync");
  expect(preview.changes.some((v: any) => v.label === "角色提示词")).toBe(true);
  await call("role:update", { roleId: a, intro: "another change" });
  await expect(
    call("workbench:applyRoleChange", {
      id: w.id,
      roleId: a,
      targetRoleId: a,
      token: preview.token,
      summary: "确认更新",
      confirmed: true,
    }),
  ).rejects.toThrow("重新预览");
  const previousReview = await call("workbench:review", {
    id: w.id,
    roleId: a,
  });
  const latest = await call("workbench:roleChangePreview", {
    id: w.id,
    roleId: a,
  });
  const synced = await call("workbench:applyRoleChange", {
    id: w.id,
    roleId: a,
    targetRoleId: a,
    token: latest.token,
    summary: "确认更新",
    confirmed: true,
  });
  expect(synced.participants[0].configuration.systemPrompt).toBe(
    "CHANGED_PROMPT",
  );
  expect(synced.phase).toBe("stopped");
  await expect(
    call("workbench:apply", {
      id: w.id,
      roleId: a,
      reviewToken: previousReview.token,
    }),
  ).rejects.toThrow("重新审阅");
});
it("hands off scoped file results into a fresh private session, revokes access and preserves historical ownership", async () => {
  const w = await call("workbench:create", { title: "交接", roleIds: [a, b] });
  core.memory.write({
    scopeType: "role",
    scopeId: a,
    title: "前端经验",
    content: "A_PRIVATE_MEMORY",
  });
  route(a);
  ensureFauxRegistered("a").setResponses([
    json({ plan: "前端分工", contracts: [] }),
    fauxAssistantMessage([
      fauxToolCall("write", {
        path: "front.txt",
        content: "shared-file-result",
      }),
    ]),
    fauxAssistantMessage("文件完成"),
  ]);
  await call("workbench:send", {
    id: w.id,
    text: "前端工作",
    requestId: "original",
  });
  const old = await phase(w.id, "awaiting_review");
  await call("workbench:setAccess", {
    id: w.id,
    roleId: a,
    commands: true,
    network: true,
    servers: [],
  });
  expect(
    core.workbench
      .get(w.id)
      .access?.some((p) => p.roleId === a && p.commands && p.network),
  ).toBe(true);
  const oldTask = old.participants.find((p) => p.roleId === a)!.taskId!;
  const run = core.db
    .prepare("SELECT root FROM workbench_runs WHERE task_id=?")
    .get(oldTask) as { root: string };
  const p = await call("workbench:roleChangePreview", {
    id: w.id,
    roleId: a,
    targetRoleId: c,
  });
  expect(p.files).toEqual([{ path: "front.txt", kind: "added" }]);
  writeFileSync(join(run.root, "front.txt"), "changed-after-preview");
  await expect(
    call("workbench:applyRoleChange", {
      id: w.id,
      roleId: a,
      targetRoleId: c,
      token: p.token,
      summary: "接手页面",
      confirmed: true,
    }),
  ).rejects.toThrow("重新预览");
  const fresh = await call("workbench:roleChangePreview", {
    id: w.id,
    roleId: a,
    targetRoleId: c,
  });
  await call("role:archive", { roleId: a, archived: true });
  const afterArchive = await call("workbench:roleChangePreview", {
    id: w.id,
    roleId: a,
    targetRoleId: c,
  });
  expect(afterArchive.available).toBe(false);
  const changed = await call("workbench:applyRoleChange", {
    id: w.id,
    roleId: a,
    targetRoleId: c,
    token: afterArchive.token,
    summary: "接手现有页面文件，继续检查。",
    confirmed: true,
  });
  const replacement = changed.participants.find((p: any) => p.roleId === c);
  expect(replacement.taskId).toBeNull();
  expect(replacement.enabled).toBe(false);
  expect(
    changed.access?.some((p: any) => p.roleId === a || p.roleId === c),
  ).toBeFalsy();
  expect(changed.roleHistory).toContainEqual(
    expect.objectContaining({ roleId: a, name: "原前端" }),
  );
  expect(
    core.db.prepare("SELECT id FROM tasks WHERE id=?").get(oldTask),
  ).toBeTruthy();
  expect(readFileSync(join(run.root, "front.txt"), "utf8")).toBe(
    "changed-after-preview",
  );
  await expect(
    call("workbench:review", { id: w.id, roleId: a }),
  ).rejects.toThrow();
  await call("workbench:setEnabled", { id: w.id, roleId: c, enabled: true });
  route(c);
  let context = "";
  ensureFauxRegistered("c").setResponses([
    json({ plan: "接手职责", contracts: [] }),
    fauxAssistantMessage([fauxToolCall("read", { path: "front.txt" })]),
    (ctx) => {
      context = JSON.stringify(ctx);
      return fauxAssistantMessage("已检查接手的文件");
    },
  ]);
  await call("workbench:send", {
    id: w.id,
    text: "继续处理页面",
    requestId: "continue-c",
  });
  const final = await phase(w.id, "awaiting_review");
  expect(context).toContain("changed-after-preview");
  expect(context).toContain("NEW_PRIVATE_PROMPT");
  expect(context).not.toContain("OLD_PRIVATE_PROMPT");
  expect(context).not.toContain("A_PRIVATE_MEMORY");
  expect(final.participants.find((p) => p.roleId === c)?.taskId).not.toBe(
    oldTask,
  );
});
it("blocks conflicts, pending proposals and role merges before handoff", async () => {
  const w = await call("workbench:create", { title: "冲突", roleIds: [a, b] });
  await expect(
    call("workbench:roleChangePreview", {
      id: w.id,
      roleId: a,
      targetRoleId: b,
    }),
  ).rejects.toThrow("已参与");
  const raw = core.workbench.get(w.id);
  raw.proposals.push({
    id: "proposal",
    contractId: "api",
    roleId: a,
    baseVersion: 1,
    content: "x",
    reason: "x",
    status: "pending",
  });
  core.db
    .prepare("UPDATE workbenches SET body=? WHERE id=?")
    .run(JSON.stringify(raw), w.id);
  const p = await call("workbench:roleChangePreview", {
    id: w.id,
    roleId: a,
    targetRoleId: c,
  });
  expect(p.blockedReason).toContain("未决");
  await expect(
    call("workbench:applyRoleChange", {
      id: w.id,
      roleId: a,
      targetRoleId: c,
      token: p.token,
      summary: "交接",
      confirmed: true,
    }),
  ).rejects.toThrow("未决");
});
it("uses isolated continuation for ordinary handoff and preserves the original session and memory", async () => {
  const old = await call("task:create", { title: "旧对话", roleId: a });
  ensureFauxRegistered("a").setResponses([
    fauxAssistantMessage("历史回复不应复制"),
  ]);
  await call("task:prompt", { taskId: old.id, text: "记录我的任务" });
  for (
    let i = 0;
    i < 200 && (await core.tasks.getTask(old.id)).task.status !== "done";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  const preview = await call("task:roleChangePreview", {
    taskId: old.id,
    targetRoleId: c,
  });
  const task = await call("task:applyRoleChange", {
    taskId: old.id,
    targetRoleId: c,
    token: preview.token,
    summary: "只需检查当前项目文档。",
    confirmed: true,
  });
  expect(task.id).not.toBe(old.id);
  expect(
    (await call("task:get", { taskId: old.id })).task.roleSuccessorId,
  ).toBe(task.id);
  let context = "";
  ensureFauxRegistered("c").setResponses([
    (ctx) => {
      context = JSON.stringify(ctx);
      return fauxAssistantMessage("接续完成");
    },
  ]);
  await call("task:prompt", { taskId: task.id, text: "请回顾交接说明" });
  for (
    let i = 0;
    i < 200 && (await core.tasks.getTask(task.id)).task.status !== "done";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  expect(context).toContain("只需检查当前项目文档");
  expect(context).not.toContain("历史回复不应复制");
  expect(context).not.toContain("OLD_PRIVATE_PROMPT");
  await expect(
    call("task:prompt", { taskId: old.id, text: "再执行" }),
  ).rejects.toThrow("接续会话");
});
it("archives affect existing tasks and refuse reuse without silently choosing a default", async () => {
  const task = await call("task:create", { title: "关联对话", roleId: a }),
    w = await call("workbench:create", { title: "关联协作", roleIds: [a, b] });
  const impact = await call("role:impact", { roleId: a });
  expect(impact.tasks.some((t: any) => t.id === task.id)).toBe(true);
  expect(impact.workbenches.some((t: any) => t.id === w.id)).toBe(true);
  await call("role:archive", { roleId: a, archived: true });
  expect(
    core.workbench.get(w.id).participants.find((p) => p.roleId === a)?.enabled,
  ).toBe(false);
  await expect(
    call("task:prompt", { taskId: task.id, text: "执行" }),
  ).rejects.toThrow("职责交接");
  await expect(
    call("workbench:setEnabled", { id: w.id, roleId: a, enabled: true }),
  ).rejects.toThrow("替代");
  await call("role:archive", { roleId: a, archived: false });
  expect(
    core.workbench.get(w.id).participants.find((p) => p.roleId === a)?.enabled,
  ).toBe(false);
});
it("refuses role changes during an active routing call and archive cancels that call", async () => {
  const w = await call("workbench:create", {
    title: "运行中归档",
    roleIds: [a, b],
  });
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  let aborted = false;
  ensureFauxRegistered().setResponses([
    (_ctx, opts) => {
      started();
      return new Promise((resolve) =>
        opts!.signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve(fauxAssistantMessage("aborted", { stopReason: "aborted" }));
          },
          { once: true },
        ),
      );
    },
  ]);
  await call("workbench:send", { id: w.id, text: "开始", requestId: "busy" });
  await ready;
  const preview = await call("workbench:roleChangePreview", {
    id: w.id,
    roleId: a,
    targetRoleId: c,
  });
  expect(preview.blockedReason).toContain("停止");
  await expect(
    call("workbench:applyRoleChange", {
      id: w.id,
      roleId: a,
      targetRoleId: c,
      token: preview.token,
      summary: "交接",
      confirmed: true,
    }),
  ).rejects.toThrow("停止");
  await call("role:archive", { roleId: a, archived: true });
  expect(aborted).toBe(true);
  expect(core.workbench.get(w.id).phase).toBe("stopped");
  expect(
    core.workbench.get(w.id).participants.find((p) => p.roleId === a)?.status,
  ).toBe("unavailable");
});
it("syncs ordinary role configuration only after confirmation and rejects stale previews", async () => {
  const task = await call("task:create", { title: "配置同步", roleId: a });
  await call("role:update", {
    roleId: a,
    systemPrompt: "UPDATED_SINGLE_PROMPT",
  });
  let before = "";
  ensureFauxRegistered("a").setResponses([
    (ctx) => {
      before = JSON.stringify(ctx);
      return fauxAssistantMessage("旧配置完成");
    },
  ]);
  await call("task:prompt", { taskId: task.id, text: "先回顾" });
  for (
    let i = 0;
    i < 200 && (await core.tasks.getTask(task.id)).task.status !== "done";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  expect(before).toContain("OLD_PRIVATE_PROMPT");
  expect(before).not.toContain("UPDATED_SINGLE_PROMPT");
  const old = await call("task:roleChangePreview", { taskId: task.id });
  await call("role:update", { roleId: a, intro: "updated intro" });
  await expect(
    call("task:applyRoleChange", {
      taskId: task.id,
      targetRoleId: a,
      token: old.token,
      summary: "更新",
      confirmed: true,
    }),
  ).rejects.toThrow("重新预览");
  const fresh = await call("task:roleChangePreview", { taskId: task.id });
  await call("task:applyRoleChange", {
    taskId: task.id,
    targetRoleId: a,
    token: fresh.token,
    summary: "采用新版配置",
    confirmed: true,
  });
  let after = "";
  ensureFauxRegistered("a").setResponses([
    (ctx) => {
      after = JSON.stringify(ctx);
      return fauxAssistantMessage("新配置完成");
    },
  ]);
  await call("task:prompt", { taskId: task.id, text: "继续回顾" });
  for (
    let i = 0;
    i < 200 && (await core.tasks.getTask(task.id)).task.status !== "done";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  expect(after).toContain("UPDATED_SINGLE_PROMPT");
});
it("keeps related contract history while replacing responsibility and refuses file conflicts", async () => {
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  writeFileSync(join(projectDir, "front.txt"), "baseline");
  const project = await call("project:add", { dir: projectDir });
  const w = await call("workbench:create", {
    title: "文件冲突",
    projectId: project.id,
    roleIds: [a, b],
  });
  route(a);
  ensureFauxRegistered("a").setResponses([
    json({
      plan: "规划",
      contracts: [
        { id: "api", title: "接口", content: "field", roles: [a, b] },
      ],
    }),
    fauxAssistantMessage([
      fauxToolCall("write", { path: "front.txt", content: "role version" }),
    ]),
    fauxAssistantMessage("完成"),
  ]);
  await call("workbench:send", {
    id: w.id,
    text: "调整页面",
    requestId: "conflict",
  });
  await phase(w.id, "awaiting_review");
  writeFileSync(join(projectDir, "front.txt"), "manual version");
  const blocked = await call("workbench:roleChangePreview", {
    id: w.id,
    roleId: a,
    targetRoleId: c,
  });
  expect(blocked.blockedReason).toContain("冲突");
  await expect(
    call("workbench:applyRoleChange", {
      id: w.id,
      roleId: a,
      targetRoleId: c,
      token: blocked.token,
      summary: "交接",
      confirmed: true,
    }),
  ).rejects.toThrow("冲突");
  writeFileSync(join(projectDir, "front.txt"), "baseline");
  const fresh = await call("workbench:roleChangePreview", {
    id: w.id,
    roleId: a,
    targetRoleId: c,
  });
  const changed = await call("workbench:applyRoleChange", {
    id: w.id,
    roleId: a,
    targetRoleId: c,
    token: fresh.token,
    summary: "交接接口职责",
    confirmed: true,
  });
  expect(changed.contracts[0].roles).toEqual([c, b]);
  expect(changed.contracts[0].version).toBe(2);
  expect(readFileSync(join(projectDir, "front.txt"), "utf8")).toBe("baseline");
});
it("rejects inherited artifacts changed after confirmation before any new worker executes", async () => {
  const w = await call("workbench:create", {
    title: "交接后变化",
    roleIds: [a, b],
  });
  route(a);
  ensureFauxRegistered("a").setResponses([
    json({ plan: "页面", contracts: [] }),
    fauxAssistantMessage([
      fauxToolCall("write", { path: "front.txt", content: "approved" }),
    ]),
    fauxAssistantMessage("完成"),
  ]);
  await call("workbench:send", {
    id: w.id,
    text: "处理前端",
    requestId: "inherit-before",
  });
  const done = await phase(w.id, "awaiting_review");
  const taskId = done.participants.find((p) => p.roleId === a)!.taskId!;
  const run = core.db
    .prepare("SELECT root FROM workbench_runs WHERE task_id=?")
    .get(taskId) as { root: string };
  const preview = await call("workbench:roleChangePreview", {
    id: w.id,
    roleId: a,
    targetRoleId: c,
  });
  await call("workbench:applyRoleChange", {
    id: w.id,
    roleId: a,
    targetRoleId: c,
    token: preview.token,
    summary: "只接手已确认文件",
    confirmed: true,
  });
  writeFileSync(join(run.root, "front.txt"), "unreviewed-change");
  await call("workbench:setEnabled", { id: w.id, roleId: c, enabled: true });
  route(c);
  ensureFauxRegistered("c").setResponses([
    json({ plan: "接续", contracts: [] }),
    () => {
      throw Error("不应启动工作模型");
    },
  ]);
  await call("workbench:send", {
    id: w.id,
    text: "继续前端",
    requestId: "inherit-after",
  });
  const failed = await phase(w.id, "error");
  expect(failed.messages.at(-1)?.text).toContain("交接文件已变化");
  expect(failed.participants.find((p) => p.roleId === c)?.taskId).toBeNull();
  const recheck = await call("workbench:roleChangePreview", {
    id: w.id,
    roleId: c,
  });
  expect(recheck.changed).toBe(true);
});
it('backfills legacy workbenches from the worker snapshot without replay or adopting later role edits',async()=>{
 const w=await call('workbench:create',{title:'旧记录兼容',roleIds:[a,b]});route(a);ensureFauxRegistered('a').setResponses([json({plan:'旧规划',contracts:[]}),fauxAssistantMessage('原任务完成')]);await call('workbench:send',{id:w.id,text:'先完成原工作',requestId:'legacy-config'});await phase(w.id,'awaiting_review');const raw=JSON.parse((core.db.prepare('SELECT body FROM workbenches WHERE id=?').get(w.id) as {body:string}).body);for(const p of raw.participants)delete p.configuration;core.db.prepare('UPDATE workbenches SET body=? WHERE id=?').run(JSON.stringify(raw),w.id);await call('role:update',{roleId:a,systemPrompt:'LATER_CONFIGURATION'});const before=core.db.prepare('SELECT COUNT(*) n FROM usage_ledger').get();await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});const restored=core.workbench.get(w.id);expect(restored.participants.find(p=>p.roleId===a)?.configuration?.systemPrompt).toBe('OLD_PRIVATE_PROMPT');expect(restored.participants.find(p=>p.roleId===a)?.configurationChanged).toBe(true);expect(restored.phase).toBe('awaiting_review');expect(core.db.prepare('SELECT COUNT(*) n FROM usage_ledger').get()).toEqual(before);
});
