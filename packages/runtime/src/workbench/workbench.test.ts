import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createHarnessCore, type HarnessCore } from "../core/harness-core.js";
import { ensureFauxRegistered, fauxModelRef } from "../pi/faux-provider.js";
let core: HarnessCore, dir: string, a: string, b: string;
async function invoke(name: string, input: unknown = {}): Promise<any> {
  // Application is deliberately preceded by the public review command.
  if (
    name === "workbench:apply" &&
    input &&
    !(input as { reviewToken?: string }).reviewToken
  ) {
    const value = input as { id: string; roleId: string };
    const review = await invoke("workbench:review", value);
    input = { ...value, reviewToken: review.token };
  }
  const r = await core.router.invoke(name, input);
  if (!r.ok) throw new Error(r.error.message);
  return r.result;
}
async function wait(id: string, phase: string) {
  for (let i = 0; i < 400; i++) {
    const w = core.workbench.get(id);
    if (w.phase === phase) return w;
    if (w.phase === "error") throw new Error(JSON.stringify(w.messages.at(-1)));
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(
    "timeout waiting " + phase + " got " + core.workbench.get(id).phase,
  );
}
const json = (value: unknown) => fauxAssistantMessage(JSON.stringify(value));
function dispatch() {
  ensureFauxRegistered().setResponses([
    json({
      reply: "按文件分工",
      action: "dispatch",
      roleIds: [a, b],
      assignments: [
        {
          roleId: a,
          instructions: "写前端",
          files: ["front.txt"],
          dependsOn: [],
        },
        {
          roleId: b,
          instructions: "读取前端后写后端",
          files: ["back.txt"],
          dependsOn: [a],
        },
      ],
    }),
  ]);
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pih-workbench-"));
  core = await createHarnessCore({ dataDir: dir, enableFaux: true });
  await invoke("settings:set", {
    defaultModel: fauxModelRef(),
    permissionMode: "bypass",
    autoApproveTools: [],
  });
  a = (
    await invoke("role:create", {
      name: "前端",
      systemPrompt: "前端工作",
      preferredModel: fauxModelRef("a"),
    })
  ).id;
  b = (
    await invoke("role:create", {
      name: "后端",
      systemPrompt: "后端工作",
      preferredModel: fauxModelRef("b"),
    })
  ).id;
});
afterEach(async () => {
  await core.shutdown();
  rmSync(dir, { recursive: true, force: true });
});
it("recommends without execution, keeps the request visible and deduplicates retries", async () => {
  const w = await invoke("workbench:create", { title: "网站" });
  ensureFauxRegistered().setResponses([
    json({
      reply: "建议前后端",
      action: "recommend",
      roleIds: [a, b],
      assignments: [],
    }),
  ]);
  await invoke("workbench:send", {
    id: w.id,
    text: "做个网站",
    requestId: "one",
  });
  await wait(w.id, "awaiting_roles");
  await invoke("workbench:send", {
    id: w.id,
    text: "做个网站",
    requestId: "one",
  });
  const got = core.workbench.get(w.id);
  expect(got.messages.filter((m) => m.sender === "你")).toHaveLength(1);
  expect(got.recommendations).toEqual([a, b]);
  expect(await core.tasks.listTasks()).toHaveLength(0);
});
it("only answers a retrospective question, without waking workers", async () => {
  const w = await invoke("workbench:create", {
    title: "回顾",
    roleIds: [a, b],
  });
  ensureFauxRegistered().setResponses([
    json({
      reply: "还未执行",
      action: "clarify",
      roleIds: [],
      assignments: [],
    }),
  ]);
  await invoke("workbench:send", {
    id: w.id,
    text: "之前做了什么",
    requestId: "review",
  });
  expect(
    (await wait(w.id, "clarify")).participants.every((p) => p.taskId === null),
  ).toBe(true);
});
it("rejects invented roles without launching a task", async () => {
  const w = await invoke("workbench:create", { title: "无效推荐" });
  ensureFauxRegistered().setResponses([
    json({
      reply: "bad",
      action: "recommend",
      roleIds: ["imaginary"],
      assignments: [],
    }),
  ]);
  await invoke("workbench:send", { id: w.id, text: "do", requestId: "bad" });
  for (let i = 0; i < 100 && core.workbench.get(w.id).phase !== "error"; i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(core.workbench.get(w.id).phase).toBe("error");
  expect(await core.tasks.listTasks()).toHaveLength(0);
});
it("runs private contexts and files, hands off dependency output and cleans up", async () => {
  const w = await invoke("workbench:create", {
    title: "网站",
    roleIds: [a, b],
  });
  dispatch();
  let aContext = "",
    bContext = "";
  core.memory.write({
    scopeType: "role",
    scopeId: a,
    title: "网站经验A",
    content: "only-a-knowledge",
  });
  core.memory.write({
    scopeType: "role",
    scopeId: b,
    title: "网站经验B",
    content: "only-b-knowledge",
  });
  ensureFauxRegistered("a").setResponses([
    json({ plan: "前端职责", contracts: [] }),
    (ctx) => {
      aContext = JSON.stringify(ctx);
      return fauxAssistantMessage([
        fauxToolCall("write", { path: "front.txt", content: "frontend" }),
      ]);
    },
    fauxAssistantMessage("前端已写"),
  ]);
  ensureFauxRegistered("b").setResponses([
    json({ plan: "后端职责", contracts: [] }),
    (ctx) => {
      bContext = JSON.stringify(ctx);
      return fauxAssistantMessage([
        fauxToolCall("read", { path: "front.txt" }),
      ]);
    },
    (ctx) => {
      expect(JSON.stringify(ctx)).toContain("frontend");
      return fauxAssistantMessage([
        fauxToolCall("write", { path: "back.txt", content: "backend" }),
      ]);
    },
    fauxAssistantMessage("后端已写"),
  ]);
  await invoke("workbench:send", {
    id: w.id,
    text: "实现网站",
    requestId: "work",
  });
  const got = await wait(w.id, "awaiting_review");
  expect(aContext).not.toContain("only-b-knowledge");
  expect(bContext).not.toContain("only-a-knowledge");
  expect(aContext).toContain("only-a-knowledge");
  expect(bContext).toContain("only-b-knowledge");
  expect(existsSync(join(dir, "personal", "front.txt"))).toBe(false);
  expect(await core.tasks.listTasks()).toHaveLength(0);
  for (const id of [a, b])
    expect((await invoke("workbench:apply", { id: w.id, roleId: id })).ok).toBe(
      true,
    );
  expect(readFileSync(join(dir, "personal", "front.txt"), "utf8")).toBe(
    "frontend",
  );
  expect(readFileSync(join(dir, "personal", "back.txt"), "utf8")).toBe(
    "backend",
  );
  await invoke("workbench:delete", { id: w.id });
  expect(core.db.prepare("SELECT * FROM workbench_runs").all()).toEqual([]);
  expect(existsSync(join(dir, "workbench-workspaces", w.id))).toBe(false);
  expect(core.db.prepare("SELECT * FROM tasks").all()).toEqual([]);
  expect(existsSync(join(dir, "personal", "front.txt"))).toBe(true);
}, 15000);
it("paused roles cannot be dispatched and are not silently re-enabled", async () => {
  const w = await invoke("workbench:create", {
    title: "暂停",
    roleIds: [a, b],
  });
  await invoke("workbench:setEnabled", { id: w.id, roleId: a, enabled: false });
  dispatch();
  await invoke("workbench:send", {
    id: w.id,
    text: "修改",
    requestId: "paused",
  });
  for (let i = 0; i < 100 && core.workbench.get(w.id).phase !== "error"; i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(core.workbench.get(w.id).participants[0]!.enabled).toBe(false);
  expect(core.db.prepare("SELECT * FROM workbench_runs").all()).toEqual([]);
});
it("fences contract decisions and rejects retired task modes", async () => {
  const w = await invoke("workbench:create", {
    title: "约定",
    roleIds: [a, b],
  });
  const body = {
    ...w,
    contracts: [
      { id: "api", title: "接口", content: "v1", version: 1, roles: [a, b] },
    ],
  };
  core.db
    .prepare("UPDATE workbenches SET body=? WHERE id=?")
    .run(JSON.stringify(body), w.id);
  let changed = await invoke("workbench:propose", {
    id: w.id,
    roleId: a,
    contractId: "api",
    baseVersion: 1,
    content: "v2",
    reason: "改字段",
  });
  await expect(
    invoke("workbench:choose", {
      id: w.id,
      proposalId: changed.proposals[0].id,
      revision: 0,
    }),
  ).rejects.toThrow("已更新");
  await invoke("workbench:choose", {
    id: w.id,
    proposalId: changed.proposals[0].id,
    revision: changed.revision,
  });
  await expect(
    invoke("workbench:propose", {
      id: w.id,
      roleId: b,
      contractId: "api",
      baseVersion: 1,
      content: "v3",
      reason: "过期",
    }),
  ).rejects.toThrow("版本");
  await expect(
    invoke("task:create", { mode: "team", roleIds: [a, b] }),
  ).rejects.toThrow("校验");
});
it("blocks out-of-scope writes even in bypass mode and stages memory until verified acceptance", async () => {
  const w = await invoke("workbench:create", {
    title: "边界",
    roleIds: [a, b],
  });
  dispatch();
  let receipts = "";
  ensureFauxRegistered("a").setResponses([
    json({ plan: "范围内写入", contracts: [] }),
    fauxAssistantMessage([
      fauxToolCall("write", {
        path: join(dir, "outside.txt"),
        content: "forbidden",
      }),
    ]),
    (ctx) => {
      receipts = JSON.stringify(ctx.messages);
      return fauxAssistantMessage([
        fauxToolCall("write", { path: "back.txt", content: "also forbidden" }),
      ]);
    },
    fauxAssistantMessage([
      fauxToolCall("write", { path: "front.txt", content: "allowed" }),
    ]),
    fauxAssistantMessage([
      fauxToolCall("save_memory", {
        scope: "role",
        title: "方法",
        content: "经过验收的工作方法",
      }),
    ]),
    fauxAssistantMessage("done"),
  ]);
  ensureFauxRegistered("b").setResponses([
    json({ plan: "后端", contracts: [] }),
    fauxAssistantMessage([
      fauxToolCall("write", { path: "back.txt", content: "backend" }),
    ]),
    fauxAssistantMessage("done"),
  ]);
  await invoke("workbench:send", {
    id: w.id,
    text: "实现工作",
    requestId: "bounds",
  });
  const review = await wait(w.id, "awaiting_review");
  expect(existsSync(join(dir, "outside.txt"))).toBe(false);
  expect(receipts).toContain("路径");
  expect(
    core.memory.list({ scopeType: "role", scopeId: a }).items,
  ).toHaveLength(0);
  expect(review.memories).toHaveLength(1);
  await expect(
    invoke("workbench:finish", {
      id: w.id,
      evidence: "not applied",
      memoryIds: [],
    }),
  ).rejects.toThrow("应用");
  for (const roleId of [a, b])
    await invoke("workbench:apply", { id: w.id, roleId });
  await invoke("workbench:finish", {
    id: w.id,
    evidence: "已核对文件内容与接口结果",
    memoryIds: [review.memories![0]!.id],
  });
  expect(
    core.memory.list({ scopeType: "role", scopeId: a }).items,
  ).toMatchObject([
    {
      content: "经过验收的工作方法",
      sourceTaskId: review.participants[0]!.taskId,
    },
  ]);
  expect(core.workbench.get(w.id).phase).toBe("done");
});
it("stops during a model wait, resumes only by a new request and never auto-replays after restart", async () => {
  const w = await invoke("workbench:create", {
    title: "取消",
    roleIds: [a, b],
  });
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  ensureFauxRegistered().setResponses([
    (_ctx, opts) => {
      started();
      return new Promise((resolve) =>
        opts!.signal!.addEventListener(
          "abort",
          () =>
            resolve(fauxAssistantMessage("aborted", { stopReason: "aborted" })),
          { once: true },
        ),
      );
    },
  ]);
  await invoke("workbench:send", { id: w.id, text: "开始", requestId: "stop" });
  await ready;
  await invoke("workbench:stop", { id: w.id });
  expect(core.workbench.get(w.id).phase).toBe("stopped");
  expect(core.db.prepare("SELECT * FROM workbench_runs").all()).toHaveLength(0);
  const stored = core.workbench.get(w.id);
  stored.phase = "running";
  core.db
    .prepare("UPDATE workbenches SET body=? WHERE id=?")
    .run(JSON.stringify(stored), w.id);
  await core.shutdown();
  core = await createHarnessCore({ dataDir: dir, enableFaux: true });
  expect(core.workbench.get(w.id).phase).toBe("stopped");
  expect(core.db.prepare("SELECT * FROM workbench_runs").all()).toHaveLength(0);
});
it("keeps a role's private continuation, wakes only the selected role and checks current contract versions on apply", async () => {
  const w = await invoke("workbench:create", {
    title: "续写",
    roleIds: [a, b],
  });
  const assign = (text: string) =>
    json({
      reply: text,
      action: "dispatch",
      roleIds: [a],
      assignments: [
        { roleId: a, instructions: text, files: ["front.txt"], dependsOn: [] },
      ],
    });
  ensureFauxRegistered().setResponses([
    assign("第一次实现"),
    assign("仅修改前端"),
  ]);
  let continuation = "";
  ensureFauxRegistered("a").setResponses([
    json({ plan: "前端规划", contracts: [] }),
    fauxAssistantMessage([
      fauxToolCall("write", { path: "front.txt", content: "one" }),
    ]),
    fauxAssistantMessage("private-front-result"),
    json({ plan: "续写规划", contracts: [] }),
    (ctx) => {
      continuation = JSON.stringify(ctx.messages);
      return fauxAssistantMessage([
        fauxToolCall("write", { path: "front.txt", content: "two" }),
      ]);
    },
    fauxAssistantMessage("second result"),
  ]);
  ensureFauxRegistered("b").setResponses([
    () => {
      throw new Error("unrelated role must not run");
    },
  ]);
  await invoke("workbench:send", {
    id: w.id,
    text: "实现前端",
    requestId: "first",
  });
  await wait(w.id, "awaiting_review");
  await invoke("workbench:apply", { id: w.id, roleId: a });
  await invoke("workbench:send", {
    id: w.id,
    text: "仅修改前端",
    requestId: "second",
  });
  const current = await wait(w.id, "awaiting_review");
  expect(continuation).toContain("private-front-result");
  expect(
    current.messages.findLast((m) => m.kind === "result" && m.sender === a)
      ?.text,
  ).not.toContain("second result");
  expect(current.participants.find((p) => p.roleId === b)!.taskId).toBeNull();
  const body = {
    ...current,
    contracts: [
      {
        id: "new",
        title: "新约定",
        content: "changed",
        version: 2,
        roles: [a],
      },
    ],
  };
  core.db
    .prepare("UPDATE workbenches SET body=? WHERE id=?")
    .run(JSON.stringify(body), w.id);
  await expect(
    invoke("workbench:apply", { id: w.id, roleId: a }),
  ).rejects.toThrow("约定已更新");
  expect(readFileSync(join(dir, "personal", "front.txt"), "utf8")).toBe("one");
});
it("executes independent roles concurrently and pausing one cancels its pending write", async () => {
  const w = await invoke("workbench:create", {
    title: "并行",
    roleIds: [a, b],
  });
  ensureFauxRegistered().setResponses([
    json({
      reply: "独立并行",
      action: "dispatch",
      roleIds: [a, b],
      assignments: [
        { roleId: a, instructions: "A", files: ["front.txt"], dependsOn: [] },
        { roleId: b, instructions: "B", files: ["back.txt"], dependsOn: [] },
      ],
    }),
  ]);
  let beganA!: () => void, beganB!: () => void, finishB!: () => void;
  const startedA = new Promise<void>((r) => (beganA = r)),
    startedB = new Promise<void>((r) => (beganB = r));
  ensureFauxRegistered("a").setResponses([
    json({ plan: "A", contracts: [] }),
    (_ctx, opts) => {
      beganA();
      return new Promise((resolve) =>
        opts!.signal!.addEventListener(
          "abort",
          () =>
            resolve(
              fauxAssistantMessage("cancelled", { stopReason: "aborted" }),
            ),
          { once: true },
        ),
      );
    },
    fauxAssistantMessage([
      fauxToolCall("write", { path: "front.txt", content: "must not write" }),
    ]),
  ]);
  ensureFauxRegistered("b").setResponses([
    json({ plan: "B", contracts: [] }),
    () => {
      beganB();
      return new Promise((resolve) => {
        finishB = () => resolve(fauxAssistantMessage("B done"));
      });
    },
  ]);
  await invoke("workbench:send", {
    id: w.id,
    text: "并行实现",
    requestId: "parallel",
  });
  await Promise.all([startedA, startedB]);
  await invoke("workbench:setEnabled", { id: w.id, roleId: a, enabled: false });
  finishB();
  const done = await wait(w.id, "awaiting_review");
  const p = done.participants.find((p) => p.roleId === a)!;
  expect(p.enabled).toBe(false);
  expect(p.status).toBe("paused");
  const row = core.db
    .prepare("SELECT root FROM workbench_runs WHERE task_id=?")
    .get(p.taskId) as {
    root: string;
  };
  expect(existsSync(join(row.root, "front.txt"))).toBe(false);
}, 10000);
it("loads bounded summaries, preserves a corrupt role session and cleans up failed continuation setup", async () => {
  const w = await invoke("workbench:create", {
    title: "恢复",
    roleIds: [a, b],
  });
  const assignment = json({
    reply: "只启动前端",
    action: "dispatch",
    roleIds: [a],
    assignments: [
      { roleId: a, instructions: "工作", files: ["front.txt"], dependsOn: [] },
    ],
  });
  ensureFauxRegistered().setResponses([assignment, assignment]);
  ensureFauxRegistered("a").setResponses([
    json({ plan: "职责", contracts: [] }),
    fauxAssistantMessage("original answer"),
    json({ plan: "下一轮", contracts: [] }),
    () => {
      throw new Error("must not execute after corruption");
    },
  ]);
  await invoke("workbench:send", {
    id: w.id,
    text: "第一次执行",
    requestId: "original",
  });
  const done = await wait(w.id, "awaiting_review");
  expect((await invoke("workbench:list")).items[0].messages).toEqual([]);
  expect(
    (await invoke("workbench:get", { id: w.id })).messages.length,
  ).toBeGreaterThan(0);
  const taskId = done.participants.find((p) => p.roleId === a)!.taskId!;
  const record = core.db
    .prepare("SELECT pi_session_id FROM tasks WHERE id=?")
    .get(taskId) as { pi_session_id: string };
  writeFileSync(
    record.pi_session_id,
    readFileSync(record.pi_session_id, "utf8") + "not-json\n",
  );
  await invoke("workbench:send", {
    id: w.id,
    text: "继续新的修改",
    requestId: "corrupt",
  });
  for (let i = 0; i < 200 && core.workbench.get(w.id).phase !== "error"; i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(core.workbench.get(w.id).messages.at(-1)?.text).toContain(
    "历史记录损坏",
  );
  expect(readFileSync(record.pi_session_id, "utf8")).toContain("not-json");
  expect(core.db.prepare("SELECT id FROM tasks").all()).toHaveLength(1);
  expect(await core.tasks.listTasks()).toHaveLength(0);
});
it("retains file ownership across requests rather than letting an unrelated role take over", async () => {
  const w = await invoke("workbench:create", {
    title: "归属",
    roleIds: [a, b],
  });
  const task = await invoke("task:create", { roleId: b });
  const body = core.workbench.get(w.id);
  body.participants[1]!.taskId = task.id;
  body.participants[1]!.status = "applied";
  core.db
    .prepare("UPDATE workbenches SET body=? WHERE id=?")
    .run(JSON.stringify(body), w.id);
  core.db
    .prepare("UPDATE tasks SET workbench_owner=? WHERE id=?")
    .run(w.id, task.id);
  core.db
    .prepare("INSERT INTO workbench_runs VALUES(?,?,?,?,?,?,?,?)")
    .run(
      task.id,
      w.id,
      b,
      join(dir, "old"),
      "{}",
      JSON.stringify(["back.txt"]),
      "first",
      "[]",
    );
  ensureFauxRegistered().setResponses([
    json({
      reply: "错误分工",
      action: "dispatch",
      roleIds: [a],
      assignments: [
        {
          roleId: a,
          instructions: "越过后端职责",
          files: ["back.txt"],
          dependsOn: [],
        },
      ],
    }),
  ]);
  await invoke("workbench:send", {
    id: w.id,
    text: "修改接口",
    requestId: "owner",
  });
  for (let i = 0; i < 100 && core.workbench.get(w.id).phase !== "error"; i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(core.workbench.get(w.id).messages.at(-1)!.text).toContain(
    "其他角色负责",
  );
  expect(core.db.prepare("SELECT * FROM tasks").all()).toHaveLength(1);
});

async function appliedFixture() {
  const { manifest, cloneWorkspace } = await import("./workspace.js");
  const project = join(dir, "project");
  mkdirSync(project);
  writeFileSync(join(project, "front.txt"), "front");
  writeFileSync(join(project, "back.txt"), "back");
  const p = await invoke("project:add", { dir: project });
  const w = await invoke("workbench:create", {
    title: "联调",
    projectId: p.id,
    roleIds: [a, b],
  });
  const body = core.workbench.get(w.id);
  body.phase = "ready_verify";
  for (const role of body.participants) {
    const task = await invoke("task:create", { roleId: role.roleId });
    role.taskId = task.id;
    role.status = "applied";
    // A real applied result always has its originating isolated run and contract snapshot.
    const root = join(dir, "prepared-runs", role.roleId);
    cloneWorkspace(project, root);
    core.db.prepare("INSERT INTO workbench_runs VALUES(?,?,?,?,?,?,?,?)").run(
      task.id,w.id,role.roleId,root,JSON.stringify(manifest(project)),
      JSON.stringify([role.roleId === a ? "front.txt" : "back.txt"]),"fixture","[]",
    );
  }
  core.db
    .prepare("UPDATE workbenches SET body=? WHERE id=?")
    .run(JSON.stringify(body), w.id);
  return { id: w.id, project };
}
it.skipIf(process.platform !== "darwin")(
  "automatic acceptance stops on real failure, keeps source unchanged, fences stale receipts and can be cancelled",
  async () => {
    const { id, project } = await appliedFixture();
    await invoke("workbench:verify", {
      id,
      commands: ["printf changed > front.txt; exit 7", "touch back.txt"],
      network: false,
    });
    for (
      let i = 0;
      i < 200 && core.workbench.get(id).verification?.status === "running";
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    expect(core.workbench.get(id).verification?.status).toBe("failed");
    expect(core.workbench.get(id).verification?.steps).toHaveLength(1);
    expect(core.workbench.get(id).verification?.steps[0]?.code).toBe(7);
    expect(readFileSync(join(project, "front.txt"), "utf8")).toBe("front");
    await expect(
      invoke("workbench:finish", {
        id,
        evidence: "不能误报通过",
        memoryIds: [],
      }),
    ).rejects.toThrow("未通过");
    await invoke("workbench:verify", {
      id,
      commands: ["cat front.txt; test -f back.txt"],
      network: false,
    });
    for (
      let i = 0;
      i < 200 && core.workbench.get(id).verification?.status === "running";
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    expect(core.workbench.get(id).verification?.status).toBe("passed");
    writeFileSync(join(project, "front.txt"), "user changed");
    await expect(
      invoke("workbench:finish", {
        id,
        evidence: "已更新，旧验收失效",
        memoryIds: [],
      }),
    ).rejects.toThrow("更新");
    await invoke("workbench:verify", {
      id,
      commands: ["sleep 60"],
      network: false,
    });
    await expect(
      invoke("workbench:setAccess", {
        id,
        roleId: a,
        commands: true,
        network: false,
        servers: [],
      }),
    ).rejects.toThrow("停止");
    await expect(
      invoke("workbench:send", {
        id,
        text: "不要重叠执行",
        requestId: "overlap",
      }),
    ).rejects.toThrow("处理");
    await new Promise((r) => setTimeout(r, 60));
    await invoke("workbench:stop", { id });
    expect(core.workbench.get(id).verification?.status).toBe("cancelled");
    expect(core.workbench.get(id).phase).toBe("ready_verify");
  },
);
it("execution grants are per role, validate network prerequisites and expose only the current role's grant", async () => {
  const w = await invoke("workbench:create", {
    title: "权限",
    roleIds: [a, b],
  });
  await expect(
    invoke("workbench:setAccess", {
      id: w.id,
      roleId: a,
      commands: false,
      network: true,
      servers: [],
    }),
  ).rejects.toThrow("联网权限");
  await invoke("workbench:setAccess", {
    id: w.id,
    roleId: a,
    commands: true,
    network: false,
    servers: ["github"],
  });
  const got = core.workbench.get(w.id);
  expect(got.access).toEqual([
    { roleId: a, commands: true, network: false, servers: ["github"] },
  ]);
  await expect(
    invoke("workbench:setAccess", {
      id: w.id,
      roleId: "stranger",
      commands: true,
      network: false,
      servers: [],
    }),
  ).rejects.toThrow("未加入");
});

it.skipIf(process.platform !== "darwin")(
  "commands require a role grant and explicit approval even in bypass mode; pausing cancels a pending operation",
  async () => {
    const w = await invoke("workbench:create", {
      title: "命令审批",
      roleIds: [a, b],
    });
    await invoke("workbench:setAccess", {
      id: w.id,
      roleId: a,
      commands: true,
      network: false,
      servers: [],
    });
    const assignment = json({
      reply: "只唤醒前端",
      action: "dispatch",
      roleIds: [a],
      assignments: [
        {
          roleId: a,
          instructions: "写前端文件",
          files: ["front.txt"],
          dependsOn: [],
        },
      ],
    });
    ensureFauxRegistered().setResponses([assignment, assignment]);
    ensureFauxRegistered("a").setResponses([
      json({ plan: "写前端", contracts: [] }),
      fauxAssistantMessage([
        fauxToolCall("workbench_command", {
          command: "printf command > front.txt",
        }),
      ]),
      fauxAssistantMessage("命令完成"),
      json({ plan: "再改前端", contracts: [] }),
      fauxAssistantMessage([
        fauxToolCall("workbench_command", {
          command: "printf unsafe > front.txt",
        }),
      ]),
      fauxAssistantMessage("停止"),
    ]);
    const approval = async () => {
      for (let i = 0; i < 250; i++) {
        const wb = core.workbench.get(w.id),
          taskId = wb.participants[0]!.taskId;
        if (taskId) {
          const record = await invoke("task:get", { taskId });
          if (record.pendingApprovals?.length)
            return { taskId, request: record.pendingApprovals[0] };
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("approval timeout");
    };
    await invoke("workbench:send", {
      id: w.id,
      text: "执行实现",
      requestId: "cmd1",
    });
    const first = await approval();
    expect(first.request.toolName).toBe("workbench_command");
    await invoke("approval:decide", {
      taskId: first.taskId,
      toolCallId: first.request.toolCallId,
      approved: true,
    });
    await wait(w.id, "awaiting_review");
    const row = core.db
      .prepare("SELECT root FROM workbench_runs WHERE task_id=?")
      .get(first.taskId) as { root: string };
    expect(readFileSync(join(row.root, "front.txt"), "utf8")).toBe("command");
    await invoke("workbench:send", {
      id: w.id,
      text: "继续修改",
      requestId: "cmd2",
    });
    const second = await approval();
    await invoke("workbench:setEnabled", {
      id: w.id,
      roleId: a,
      enabled: false,
    });
    const cancelled = await invoke("task:get", { taskId: second.taskId });
    expect(cancelled.pendingApprovals ?? []).toHaveLength(0);
    const secondRoot = (
      core.db
        .prepare("SELECT root FROM workbench_runs WHERE task_id=?")
        .get(second.taskId) as { root: string }
    ).root;
    expect(readFileSync(join(secondRoot, "front.txt"), "utf8")).toBe("command");
    await invoke("workbench:stop", { id: w.id });
    await invoke("workbench:setEnabled", {
      id: w.id,
      roleId: a,
      enabled: true,
    });
    ensureFauxRegistered().setResponses([assignment]);
    ensureFauxRegistered("a").setResponses([
      json({ plan: "受控运行", contracts: [] }),
      fauxAssistantMessage([
        fauxToolCall("workbench_command", {
          command:
            "printf started > front.txt; sleep 60; printf unsafe > front.txt",
        }),
      ]),
      fauxAssistantMessage("结束"),
    ]);
    await invoke("workbench:send", {
      id: w.id,
      text: "运行测试命令",
      requestId: "cmd3",
    });
    const third = await approval();
    await invoke("approval:decide", {
      taskId: third.taskId,
      toolCallId: third.request.toolCallId,
      approved: true,
    });
    const thirdRoot = (
      core.db
        .prepare("SELECT root FROM workbench_runs WHERE task_id=?")
        .get(third.taskId) as { root: string }
    ).root;
    for (
      let i = 0;
      i < 200 &&
      readFileSync(join(thirdRoot, "front.txt"), "utf8") !== "started";
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    expect(readFileSync(join(thirdRoot, "front.txt"), "utf8")).toBe("started");
    const before = Date.now();
    await invoke("workbench:setEnabled", {
      id: w.id,
      roleId: a,
      enabled: false,
    });
    expect(Date.now() - before).toBeLessThan(2000);
    expect(readFileSync(join(thirdRoot, "front.txt"), "utf8")).toBe("started");
  },
);

it.skipIf(process.platform !== "darwin")(
  "detects and runs package installation, tests and build in an integration copy",
  async () => {
    const { id, project } = await appliedFixture();
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        scripts: {
          test: "node -e \"if(require('fs').readFileSync('front.txt','utf8')!=='front')process.exit(2)\"",
          build:
            "node -e \"require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/result.txt','built')\"",
        },
      }),
    );
    writeFileSync(
      join(project, "package-lock.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "fixture", version: "1.0.0" } },
      }),
    );
    const plan = await invoke("workbench:verificationPlan", { id });
    expect(plan.commands).toEqual([
      "npm ci --ignore-scripts",
      "npm run test",
      "npm run build",
    ]);
    await invoke("workbench:verify", {
      id,
      commands: plan.commands,
      network: false,
    });
    for (
      let i = 0;
      i < 600 && core.workbench.get(id).verification?.status === "running";
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    const result = core.workbench.get(id);
    expect(
      result.verification?.status,
      JSON.stringify(result.verification),
    ).toBe("passed");
    expect(result.verification?.steps).toHaveLength(3);
    expect(existsSync(join(project, "dist"))).toBe(false);
    await invoke("workbench:finish", {
      id,
      evidence: "已完成真实安装、测试和构建",
      memoryIds: [],
    });
    expect(core.workbench.get(id).phase).toBe("done");
  },
);

async function reviewFixture() {
  const { manifest, cloneWorkspace } = await import("./workspace.js");
  const project = join(dir, "review-project");
  mkdirSync(project);
  writeFileSync(join(project, "front.txt"), "old");
  const p = await invoke("project:add", { dir: project }),
    w = await invoke("workbench:create", {
      title: "审阅",
      projectId: p.id,
      roleIds: [a, b],
    }),
    task = await invoke("task:create", { roleId: a, projectId: p.id });
  const root = join(dir, "review-role");
  const base = cloneWorkspace(project, root);
  writeFileSync(join(root, "front.txt"), "new");
  const body = core.workbench.get(w.id);
  body.phase = "awaiting_review";
  body.participants[0]!.taskId = task.id;
  body.participants[0]!.status = "done";
  core.db
    .prepare(
      "UPDATE tasks SET status='done',workbench_owner=?,execution_root=? WHERE id=?",
    )
    .run(w.id, root, task.id);
  core.db
    .prepare("UPDATE workbenches SET body=? WHERE id=?")
    .run(JSON.stringify(body), w.id);
  core.db
    .prepare("INSERT INTO workbench_runs VALUES(?,?,?,?,?,?,?,?)")
    .run(
      task.id,
      w.id,
      a,
      root,
      JSON.stringify(base),
      JSON.stringify(["front.txt"]),
      "review-request",
      "[]",
    );
  return { id: w.id, taskId: task.id, root, project };
}
it("review receipts fence both role output and source changes; cannot read an unrelated path or another role", async () => {
  const f = await reviewFixture();
  const review = await invoke("workbench:review", { id: f.id, roleId: a });
  expect(review.total).toBe(1);
  const content = await invoke("workbench:reviewFile", {
    id: f.id,
    roleId: a,
    token: review.token,
    path: "front.txt",
  });
  expect(content.before.text).toBe("old");
  expect(content.after.text).toBe("new");
  await expect(
    invoke("workbench:reviewFile", {
      id: f.id,
      roleId: a,
      token: review.token,
      path: "../secret",
    }),
  ).rejects.toThrow("清单");
  await expect(
    invoke("workbench:review", { id: f.id, roleId: b }),
  ).rejects.toThrow("没有");
  writeFileSync(join(f.root, "front.txt"), "after review");
  await expect(
    invoke("workbench:apply", {
      id: f.id,
      roleId: a,
      reviewToken: review.token,
    }),
  ).rejects.toThrow("重新审阅");
  expect(readFileSync(join(f.project, "front.txt"), "utf8")).toBe("old");
  const next = await invoke("workbench:review", { id: f.id, roleId: a });
  writeFileSync(join(f.project, "front.txt"), "manual");
  await expect(
    invoke("workbench:apply", { id: f.id, roleId: a, reviewToken: next.token }),
  ).rejects.toThrow("重新审阅");
  const conflict = await invoke("workbench:review", { id: f.id, roleId: a });
  expect(conflict.conflicts).toBe(1);
  writeFileSync(join(f.project, "front.txt"), "old");
  const final = await invoke("workbench:review", { id: f.id, roleId: a });
  await invoke("workbench:apply", {
    id: f.id,
    roleId: a,
    reviewToken: final.token,
  });
  expect(readFileSync(join(f.project, "front.txt"), "utf8")).toBe(
    "after review",
  );
  const missing = await core.router.invoke("workbench:apply", {
    id: f.id,
    roleId: a,
  });
  expect(missing.ok).toBe(false);
});
it.skipIf(process.platform !== "darwin")(
  "failure repair routes only to the chosen enabled role, carries bounded evidence and deduplicates",
  async () => {
    const f = await reviewFixture();
    await invoke("workbench:apply", { id: f.id, roleId: a });
    await invoke("workbench:verify", {
      id: f.id,
      commands: ["printf 'fixture check failed'; exit 3"],
      network: false,
    });
    for (
      let i = 0;
      i < 200 && core.workbench.get(f.id).verification?.status === "running";
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    const v = core.workbench.get(f.id).verification!;
    expect(v.status).toBe("failed");
    const request = {
      id: f.id,
      roleId: a,
      requestId: "repair-1",
      verificationAt: v.at,
      fingerprint: v.fingerprint,
      instructions: "修复前端，不改接口",
    };
    await invoke("workbench:setEnabled", {
      id: f.id,
      roleId: a,
      enabled: false,
    });
    await expect(invoke("workbench:repair", request)).rejects.toThrow();
    // Restore the applied state explicitly to simulate the user re-enabling the same verified output.
    const body = core.workbench.get(f.id);
    body.participants[0]!.enabled = true;
    body.participants[0]!.status = "applied";
    core.db
      .prepare("UPDATE workbenches SET body=? WHERE id=?")
      .run(JSON.stringify(body), f.id);
    await expect(
      invoke("workbench:repair", { ...request, verificationAt: v.at - 1 }),
    ).rejects.toThrow("更新");
    ensureFauxRegistered().setResponses([
      json({
        reply: "交给前端修复",
        action: "dispatch",
        roleIds: [a],
        assignments: [
          {
            roleId: a,
            instructions: "检查并修复前端",
            files: ["front.txt"],
            dependsOn: [],
          },
        ],
      }),
    ]);
    ensureFauxRegistered("a").setResponses([
      json({ plan: "按证据修复", contracts: [] }),
      fauxAssistantMessage("已定位，待确认"),
    ]);
    ensureFauxRegistered("b").setResponses([
      () => {
        throw new Error("unrelated role must not run");
      },
    ]);
    await invoke("workbench:repair", request);
    await invoke("workbench:repair", request);
    const done = await wait(f.id, "awaiting_review");
    const message = done.messages.find(
      (m) => m.requestId === "repair-1" && m.sender === "你",
    );
    expect(message?.text).toContain("fixture check failed");
    expect(message?.recipients).toEqual([a]);
    expect(
      done.messages.filter(
        (m) => m.sender === "你" && m.requestId === "repair-1",
      ),
    ).toHaveLength(1);
    expect(done.participants[1]!.taskId).toBeNull();
    expect(done.verification?.status).toBe("stale");
  },
);
it("重启清除旧模式和非角色记忆，保留新工作台与普通任务",async()=>{
 const normal=await invoke('task:create',{}),old=await invoke('task:create',{}),w=await invoke('workbench:create',{title:'保留工作台'});
 core.db.prepare("UPDATE tasks SET mode='team' WHERE id=?").run(old.id);
 core.db.prepare("INSERT INTO memories(id,scope_type,scope_id,title,content,status,created_at,updated_at) VALUES('legacy-global','user','user','old','old','active',1,1)").run();
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});expect(core.db.prepare('SELECT id FROM tasks WHERE id=?').get(old.id)).toBeUndefined();expect((await invoke('task:get',{taskId:normal.id})).task.id).toBe(normal.id);expect((await invoke('workbench:get',{id:w.id})).id).toBe(w.id);expect(core.db.prepare("SELECT id FROM memories WHERE scope_type!='role'").all()).toEqual([]);
});

it("paginates beyond 200 tasks with stable ties, literal title search and summary-only results", async () => {
  const seed = await invoke("workbench:create", {title:"seed"});
  core.db.prepare("DELETE FROM workbenches WHERE id=?").run(seed.id);
  for(let i=0;i<205;i++) {
    const id="history-"+String(i).padStart(3,"0");
    const w={...seed,id,title:i===0?"旧任务 100%_完成":"历史任务 "+i,updatedAt:100,messages:[{id:"private",text:"large history"}]};
    core.db.prepare("INSERT INTO workbenches(id,body,revision,updated_at) VALUES(?,?,?,?)").run(id,JSON.stringify(w),w.revision,100);
  }
  const found:string[]=[];
  let cursor:string|undefined;
  do {
    const page=await invoke("workbench:list",{limit:50,cursor});
    expect(page.items.length).toBeLessThanOrEqual(50);
    expect(page.items.every((w:any)=>w.messages.length===0 && w.contracts.length===0)).toBe(true);
    found.push(...page.items.map((w:any)=>w.id));
    cursor=page.nextCursor??undefined;
  }while(cursor);
  expect(found).toHaveLength(205);
  expect(new Set(found).size).toBe(205);
  expect(found[0]).toBe("history-204");
  expect(found.at(-1)).toBe("history-000");
  const search=await invoke("workbench:list",{query:"100%_",limit:50});
  expect(search.items.map((w:any)=>w.id)).toEqual(["history-000"]);
  expect(search.nextCursor).toBeNull();
  const first=await invoke("workbench:list",{limit:1});
  await expect(invoke("workbench:list",{cursor:first.nextCursor,query:"different"})).rejects.toThrow("位置无效");
  await expect(invoke("workbench:list",{cursor:"invalid"})).rejects.toThrow("位置无效");
  await expect(invoke("workbench:list",{limit:201})).rejects.toThrow();
});

it("marks interrupted workbenches older than the initial page stopped without replaying work", async()=>{
  const seed=await invoke("workbench:create",{title:"seed"});
  core.db.prepare("DELETE FROM workbenches WHERE id=?").run(seed.id);
  for(let i=0;i<205;i++){
    const id="restart-"+i,w={...seed,id,updatedAt:i,phase:i===0?"routing":"draft"};
    core.db.prepare("INSERT INTO workbenches(id,body,revision,updated_at) VALUES(?,?,?,?)").run(id,JSON.stringify(w),w.revision,i);
  }
  await core.shutdown();
  core=await createHarnessCore({dataDir:dir,enableFaux:true});
  expect(core.workbench.get("restart-0").phase).toBe("stopped");
  expect(core.workbench.get("restart-0").messages.at(-1)?.text).toContain("不会自动重跑");
});

it('routes attachment bytes only to assigned roles in both planning and execution',async()=>{
 const w=await invoke('workbench:create',{title:'附件隔离',roleIds:[a,b]});
 const upload=(name:string,content:string)=>invoke('workbench:attach',{id:w.id,name,kind:'text',mimeType:'text/plain',data:Buffer.from(content).toString('base64')});
 const fa=await upload('front.md','ONLY-FRONT-ATTACHMENT'),fb=await upload('back.md','ONLY-BACK-ATTACHMENT');
 let coordinator='',aplan='',bplan='',awork='',bwork='';
 ensureFauxRegistered().setResponses([(ctx)=>{coordinator=JSON.stringify(ctx);return json({reply:'按附件分工',action:'dispatch',roleIds:[a,b],assignments:[{roleId:a,instructions:'前端',files:['front.txt'],dependsOn:[],attachmentIds:[fa.id]},{roleId:b,instructions:'后端',files:['back.txt'],dependsOn:[],attachmentIds:[fb.id]}]});}]);
 ensureFauxRegistered('a').setResponses([(ctx)=>{aplan=JSON.stringify(ctx);return json({plan:'前端计划',contracts:[]});},(ctx)=>{awork=JSON.stringify(ctx);return fauxAssistantMessage('前端完成');}]);
 ensureFauxRegistered('b').setResponses([(ctx)=>{bplan=JSON.stringify(ctx);return json({plan:'后端计划',contracts:[]});},(ctx)=>{bwork=JSON.stringify(ctx);return fauxAssistantMessage('后端完成');}]);
 await invoke('workbench:send',{id:w.id,text:'各自处理对应附件',requestId:'attach-r',attachmentIds:[fa.id,fb.id]});
 const result=await wait(w.id,'awaiting_review');
 for(const ctx of [aplan,awork]){expect(ctx).toContain('ONLY-FRONT-ATTACHMENT');expect(ctx).not.toContain('ONLY-BACK-ATTACHMENT');}
 for(const ctx of [bplan,bwork]){expect(ctx).toContain('ONLY-BACK-ATTACHMENT');expect(ctx).not.toContain('ONLY-FRONT-ATTACHMENT');}
 expect(coordinator).toContain('front.md');expect(coordinator).not.toContain('ONLY-FRONT-ATTACHMENT');
 expect(result.messages.find(m=>m.sender==='你')?.attachments?.map(f=>f.roleIds)).toEqual([[a],[b]]);
 const other=await invoke('workbench:create',{title:'另一个任务'});await expect(invoke('workbench:readAttachment',{id:other.id,attachmentId:fa.id})).rejects.toThrow('不属于');
 const duplicate=await invoke('workbench:send',{id:w.id,text:'各自处理对应附件',requestId:'attach-r',attachmentIds:[fa.id,fb.id]});expect(duplicate.accepted).toBe(true);expect(core.workbench.get(w.id).messages.filter(m=>m.sender==='你')).toHaveLength(1);
 await invoke('workbench:delete',{id:w.id});expect(core.db.prepare('SELECT id FROM workbench_attachments WHERE workbench_id=?').all(w.id)).toEqual([]);
});
it('rejects unallocated or foreign attachment assignments before professional roles start',async()=>{
 const w=await invoke('workbench:create',{title:'附件分配检查',roleIds:[a,b]});const file=await invoke('workbench:attach',{id:w.id,name:'file.txt',kind:'text',mimeType:'text/plain',data:Buffer.from('data').toString('base64')});
 ensureFauxRegistered().setResponses([json({reply:'安排',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'写',files:['front.txt'],dependsOn:[],attachmentIds:['foreign']}]})]);
 await invoke('workbench:send',{id:w.id,text:'处理附件',requestId:'bad-attach',attachmentIds:[file.id]});
 for(let i=0;i<100 && core.workbench.get(w.id).phase!=='error';i++)await new Promise(r=>setTimeout(r,10));
 expect(core.workbench.get(w.id).phase).toBe('error');expect(core.workbench.get(w.id).messages.at(-1)?.text).toContain('无权限的附件');expect(core.db.prepare('SELECT task_id FROM workbench_runs WHERE workbench_id=?').all(w.id)).toEqual([]);
});
it('keeps unsupported images visible and fails before planning instead of silently dropping them',async()=>{
 const w=await invoke('workbench:create',{title:'图片',roleIds:[a,b]});const image=await invoke('workbench:attach',{id:w.id,name:'ref.png',kind:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=='});
 ensureFauxRegistered().setResponses([json({reply:'安排',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'参考图片',files:['front.txt'],dependsOn:[],attachmentIds:[image.id]}]})]);
 await invoke('workbench:send',{id:w.id,text:'根据图片做页面',requestId:'image-r',attachmentIds:[image.id]});
 for(let i=0;i<100 && core.workbench.get(w.id).phase!=='error';i++)await new Promise(r=>setTimeout(r,10));
 expect(core.workbench.get(w.id).messages.at(-1)?.text).toContain('不支持图片');expect(core.workbench.get(w.id).messages.find(m=>m.sender==='你')?.attachments?.[0]?.id).toBe(image.id);
 expect(core.db.prepare('SELECT task_id FROM workbench_runs WHERE workbench_id=?').all(w.id)).toEqual([]);
});

it('delivers supported image blocks to the assigned role without sending them to the coordinator or inactive roles',async()=>{
 const real=core.pi.getModel.bind(core.pi);const spy=vi.spyOn(core.pi,'getModel').mockImplementation((provider,modelId)=>{const model=real(provider,modelId);return model?{...model,input:['text','image']}:model;});
 try{
 const w=await invoke('workbench:create',{title:'图片隔离',roleIds:[a,b]});const data='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==';
 const image=await invoke('workbench:attach',{id:w.id,name:'ref.png',kind:'image',mimeType:'image/png',data});
 let coordinator='',plan='',execution='';ensureFauxRegistered().setResponses([(ctx)=>{coordinator=JSON.stringify(ctx);return json({reply:'只安排前端',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'参考图片',files:['front.txt'],dependsOn:[],attachmentIds:[image.id]}]});}]);
 ensureFauxRegistered('a').setResponses([(ctx)=>{plan=JSON.stringify(ctx);return json({plan:'按图设计',contracts:[]});},(ctx)=>{execution=JSON.stringify(ctx);return fauxAssistantMessage('完成图片检查');}]);
 ensureFauxRegistered('b').setResponses([()=>{throw Error('无关角色不应运行');}]);
 await invoke('workbench:send',{id:w.id,text:'参考图片修改前端',requestId:'supported-image',attachmentIds:[image.id]});await wait(w.id,'awaiting_review');
 expect(plan).toContain(data);expect(execution).toContain(data);expect(coordinator).not.toContain(data);expect(core.workbench.get(w.id).participants.find(p=>p.roleId===b)?.taskId).toBeNull();
 }finally{spy.mockRestore();}
});
it("验收选中的同主题经验保留为待核对候选，不覆盖旧经验，并提供记忆入口",async()=>{
 const w=await invoke("workbench:create",{title:"经验核对",roleIds:[a]});
 ensureFauxRegistered().setResponses([json({reply:"明确职责",action:"dispatch",roleIds:[a],assignments:[{roleId:a,instructions:"写前端",files:["front.txt"],dependsOn:[]}]})]);
 ensureFauxRegistered("a").setResponses([json({plan:"前端",contracts:[]}),fauxAssistantMessage([fauxToolCall("write",{path:"front.txt",content:"new page"})]),fauxAssistantMessage([fauxToolCall("save_memory",{scope:"role",title:"页面预览",content:"改用动态预览",appliesTo:"预览前端页面",evidence:"模型称已通过"})]),fauxAssistantMessage("完成")]);
 await invoke("workbench:send",{id:w.id,text:"实现工作",requestId:"quality"});const pending=await wait(w.id,"awaiting_review");
 await invoke("workbench:apply",{id:w.id,roleId:a});const old=core.memory.write({scopeType:"role",scopeId:a,title:"页面预览",content:"先使用静态预览"});
 const finished=await invoke("workbench:finish",{id:w.id,evidence:"已核对生成文件，具体经验需要对比旧方式",memoryIds:[pending.memories![0]!.id]});
 const saved=core.memory.get(finished.memories[0].memoryId);expect(saved).toMatchObject({sourceWorkbenchId:w.id,quality:{verification:"pending",source:"workbench",appliesTo:"预览前端页面"}});expect(saved.quality?.evidence).toContain("用户验收");expect(saved.quality?.evidence).not.toContain("模型称已通过");expect(core.memory.get(old.id).status).toBe("active");expect(core.memory.retrieve({scopes:[{scopeType:"role",scopeId:a}],query:"页面预览"}).map(m=>m.id)).toEqual([old.id]);
});
it("raster previews use the current role receipt, refuse foreign paths and detect changes during decoding",async()=>{
 const f=await reviewFixture();core.db.prepare("UPDATE workbench_runs SET owned_paths=? WHERE task_id=?").run(JSON.stringify(["front.txt","preview.png"]),f.taskId);
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==","base64");writeFileSync(join(f.root,"preview.png"),png);const r=await invoke("workbench:review",{id:f.id,roleId:a});const image=await invoke("workbench:reviewImage",{id:f.id,roleId:a,token:r.token,path:"preview.png"});expect(image.mimeType).toBe("image/png");expect(image.data).toBeTruthy();
 await expect(invoke("workbench:reviewImage",{id:f.id,roleId:b,token:r.token,path:"preview.png"})).rejects.toThrow();await expect(invoke("workbench:reviewImage",{id:f.id,roleId:a,token:r.token,path:"../secret.png"})).rejects.toThrow();
 const pending=invoke("workbench:reviewImage",{id:f.id,roleId:a,token:r.token,path:"preview.png"});writeFileSync(join(f.root,"front.txt"),"changed while decoding");await expect(pending).rejects.toThrow("变化");
 writeFileSync(join(f.root,"preview.png"),"<svg onload='bad()'/>");const next=await invoke("workbench:review",{id:f.id,roleId:a});await expect(invoke("workbench:reviewImage",{id:f.id,roleId:a,token:next.token,path:"preview.png"})).rejects.toThrow("仅预览");
});

it.each(["done", "ready_verify", "awaiting_review"])("只读回顾保留 %s 阶段与验收回执，并向任务助手提供实际状态", async (phase) => {
  const w = await invoke("workbench:create", { title: "已交付网站", roleIds: [a, b] });
  const verification = { status: "passed", fingerprint: "unchanged-site", at: 1, steps: [{ command: "node verify.mjs", code: 0, output: "HTTP checks passed", durationMs: 1, cancelled: false }] };
  core.db.prepare("UPDATE workbenches SET body=? WHERE id=?").run(JSON.stringify({ ...w, phase, verification }), w.id);
  let observed: any;
  ensureFauxRegistered().setResponses([(ctx) => {
    observed = JSON.parse(ctx.messages.at(-1)!.content as string);
    return json({ reply: "已交付，HTTP 验收通过，本轮只回顾", action: "clarify", roleIds: [], assignments: [] });
  }]);
  await invoke("workbench:send", { id: w.id, text: "之前做了什么？只回顾不要修改", requestId: "completed-history" });
  for (let i = 0; i < 300 && !core.workbench.get(w.id).messages.some((m) => m.requestId === "completed-history" && m.kind === "reply"); i++) await new Promise((r) => setTimeout(r, 10));
  const after = core.workbench.get(w.id);
  expect(after.verification).toEqual(verification);
  expect(after.phase).toBe(phase);
  expect(observed.status).toMatchObject({ phase, verification: { status: "passed", at: 1 } });
  expect(await core.tasks.listTasks()).toHaveLength(0);
});

it("暂停和恢复已应用角色不抹掉成果状态，局部修改后仍可验收其他已应用成果", async () => {
  const w = await invoke("workbench:create", { title: "暂停已完成角色", roleIds: [a, b] });
  const body = { ...w, phase: "ready_verify", participants: w.participants.map((p: any) => ({ ...p, status: "applied" })) };
  core.db.prepare("UPDATE workbenches SET body=? WHERE id=?").run(JSON.stringify(body), w.id);
  const paused = await invoke("workbench:setEnabled", { id: w.id, roleId: b, enabled: false });
  expect(paused.participants[1]).toMatchObject({ enabled: false, status: "applied" });
  const resumed = await invoke("workbench:setEnabled", { id: w.id, roleId: b, enabled: true });
  expect(resumed.participants[1]).toMatchObject({ enabled: true, status: "applied" });
  expect(await core.tasks.listTasks()).toHaveLength(0);
});

it("旧暂停状态不能借用前一轮应用记录恢复未完成的新任务", async () => {
  const w = await invoke("workbench:create", { title: "旧暂停恢复边界", roleIds: [a, b] });
  const task = await invoke("task:create", { roleId: b });
  core.db.prepare("UPDATE tasks SET status='cancelled',workbench_owner=?,created_at=20 WHERE id=?").run(w.id, task.id);
  const body = { ...w, participants: w.participants.map((p: any) => p.roleId === b ? { ...p, enabled: false, status: "paused", taskId: task.id } : p) };
  core.db.prepare("UPDATE workbenches SET body=? WHERE id=?").run(JSON.stringify(body), w.id);
  core.db.prepare("INSERT INTO workbench_applications VALUES('old-result',?,?,'applied',10)").run(w.id, b);
  const after = await invoke("workbench:setEnabled", { id: w.id, roleId: b, enabled: false });
  expect(after.participants[1]).toMatchObject({ enabled: false, status: "paused", taskId: task.id });
});

it("模型把未就绪且未派发的角色写成依赖时安全拒绝，不扩大唤醒范围", async () => {
  const w = await invoke("workbench:create", { title: "无效依赖", roleIds: [a, b] });
  ensureFauxRegistered().setResponses([json({ reply: "仅前端", action: "dispatch", roleIds: [a], assignments: [{ roleId: a, instructions: "核对前端", files: ["front.txt"], dependsOn: [b] }] })]);
  await invoke("workbench:send", { id: w.id, text: "仅核对前端", requestId: "invalid-dependency" });
  await wait(w.id, "error");
  expect(core.workbench.get(w.id).messages.at(-1)?.text).toContain("未参与本轮");
  expect(await core.tasks.listTasks()).toHaveLength(0);
});
it('rejects disagreement between declared roles and assignments before waking any worker',async()=>{
 const w=await invoke('workbench:create',{title:'只改前端',roleIds:[a,b]});
 const audits:any[]=[];const stop=core.router.onEvent(event=>{if(event.type==='workbench:routingDecision')audits.push(event.payload);});
 ensureFauxRegistered().setResponses([json({reply:'只交给前端',action:'dispatch',roleIds:[a],assignments:[{roleId:b,instructions:'修改后端',files:['back.txt'],dependsOn:[]}]})]);
 ensureFauxRegistered('b').setResponses([json({plan:'不应该被调用',contracts:[]}),fauxAssistantMessage('不应该执行')]);
 await invoke('workbench:send',{id:w.id,text:'只调整页面按钮',requestId:'mismatch'});
 for(let i=0;i<250;i++){if(!['routing','planning','running'].includes(core.workbench.get(w.id).phase))break;await new Promise(r=>setTimeout(r,10));}
 expect(core.workbench.get(w.id).phase).toBe('error');
 expect(core.workbench.modelUsage(w.id).roles.filter(r=>r.stage!=='routing')).toEqual([]);
 expect(audits[0]).toMatchObject({id:w.id,requestId:'mismatch',decision:{roleIds:[a],assignments:[{roleId:b}]}});
 expect(JSON.stringify(audits[0])).not.toContain('instructions');
 stop();
});
it('blocks erroneous dispatch for explicit discussion-only requests while preserving audit and verification',async()=>{
 const w=await invoke('workbench:create',{title:'只比较方案',roleIds:[a,b]});
 const row=core.db.prepare('SELECT body FROM workbenches WHERE id=?').get(w.id) as {body:string};const saved=JSON.parse(row.body);saved.phase='done';saved.verification={status:'passed',fingerprint:'untouched',at:1,steps:[]};core.db.prepare('UPDATE workbenches SET body=? WHERE id=?').run(JSON.stringify(saved),w.id);
 const audits:any[]=[];const stop=core.router.onEvent(event=>{if(event.type==='workbench:routingDecision')audits.push(event.payload);});
 ensureFauxRegistered().setResponses([json({reply:'我现在让双方修改接口',action:'dispatch',roleIds:[a,b],assignments:[{roleId:a,instructions:'改页面',files:['front.txt'],dependsOn:[]},{roleId:b,instructions:'改接口',files:['back.txt'],dependsOn:[]}]})]);
 await invoke('workbench:send',{id:w.id,text:'先比较两个字段的迁移成本，先别修改约定和代码。',requestId:'discussion'});
 for(let i=0;i<250;i++){if(!['routing','planning','running'].includes(core.workbench.get(w.id).phase))break;await new Promise(r=>setTimeout(r,10));}
 const got=core.workbench.get(w.id);expect(got.phase).toBe('done');expect(got.verification).toEqual(saved.verification);
 expect(core.workbench.modelUsage(w.id).roles.filter(r=>r.stage!=='routing')).toEqual([]);
 expect(got.messages.at(-1)?.text).toContain('未启动');expect(audits[0]).toMatchObject({readOnlySuppressed:true,decision:{action:'dispatch',roleIds:[a,b]}});stop();
});
it('keeps explicit action after discussion executable within the requested role',async()=>{
 const w=await invoke('workbench:create',{title:'讨论后只改前端',roleIds:[a,b]});
 ensureFauxRegistered().setResponses([()=>{
  return json({reply:'讨论后由前端执行',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'只调整页面按钮',files:['front.txt'],dependsOn:[]}]});
 }]);
 ensureFauxRegistered('a').setResponses([json({plan:'只调整前端',contracts:[]}),fauxAssistantMessage('已接收前端任务')]);
 await invoke('workbench:send',{id:w.id,text:'先讨论文案，再把页面上的提交按钮改为发送咨询；不要改接口。',requestId:'discuss-and-act'});
 await wait(w.id,'awaiting_review');
 const activated=core.workbench.modelUsage(w.id).roles.filter(r=>r.stage!=='routing');
 expect(activated.every(r=>r.roleId===a)).toBe(true);expect(activated.map(r=>r.stage).sort()).toEqual(['execution','planning']);
});
