import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GitService } from "./git-service.js";
let cwd:string, git:GitService;
function run(...args:string[]) {return execFileSync("git",args,{cwd,encoding:"utf8",env:{...process.env,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_SYSTEM:"/dev/null"}}).trim();}
beforeEach(()=>{cwd=mkdtempSync(join(tmpdir(),"pih-git-test-"));git=new GitService();run("init","-q","-b","main");run("config","user.name","Fixture");run("config","user.email","fixture@example.invalid");writeFileSync(join(cwd,"file.txt"),"before\n");run("add","file.txt");run("commit","-qm","initial");});
afterEach(()=>rmSync(cwd,{recursive:true,force:true}));
async function act(action: "stage"|"unstage"|"commit"|"discard",paths:string[],agent=false) {const diff=await git.diff(cwd,paths);return git.mutate("task",cwd,{action,paths,version:diff.version,message:"selected change"},agent);}
it("reports missing Git and nonrepository projects without pretending they are versioned",async()=>{
 expect(await new GitService(null).status(cwd)).toMatchObject({available:false,repository:false});
 const fresh=join(cwd,"fresh");mkdirSync(fresh); // A subdirectory belongs to its parent repo.
 expect(await git.status(fresh)).toMatchObject({repository:true});
 expect(await git.status(null)).toMatchObject({repository:false});
});
it("shows staged and unstaged text separately and literal unusual filenames",async()=>{
 writeFileSync(join(cwd,"file.txt"),"staged\n");run("add","file.txt");writeFileSync(join(cwd,"file.txt"),"working\n");
 const file="space name :(literal).txt";writeFileSync(join(cwd,file),"new\n");
 const state=await git.status(cwd);expect(state.files).toEqual(expect.arrayContaining([expect.objectContaining({path:"file.txt",status:"MM",staged:true}),expect.objectContaining({path:file,tracked:false})]));
 expect((await git.diff(cwd,["file.txt"],"staged")).text).toContain("+staged");expect((await git.diff(cwd,["file.txt"],"working")).text).toContain("+working");expect((await git.diff(cwd,[file])).text).toContain("+new");
});
it("commits only selected files while preserving unrelated staged contents",async()=>{
 writeFileSync(join(cwd,"user.txt"),"user staged\n");run("add","user.txt");const staged=run("show",":user.txt");
 writeFileSync(join(cwd,"file.txt"),"agent\n");await act("commit",["file.txt"]);
 expect(run("show","HEAD:file.txt")).toBe("agent");expect(run("show",":user.txt")).toBe(staged);expect(run("diff","--cached","--name-only")).toBe("user.txt");expect(run("ls-tree","--name-only","HEAD")).not.toContain("user.txt");
});
it("supports staging, unstaging, new-file commits and restoring existing files",async()=>{
 writeFileSync(join(cwd,"new.txt"),"new\n");expect((await act("stage",["new.txt"])).files.find(f=>f.path==="new.txt")?.staged).toBe(true);
 expect((await act("unstage",["new.txt"])).files.find(f=>f.path==="new.txt")?.tracked).toBe(false);
 await act("commit",["new.txt"]);expect(run("show","HEAD:new.txt")).toBe("new");
 writeFileSync(join(cwd,"file.txt"),"wrong\n");await act("stage",["file.txt"]);await act("discard",["file.txt"]);expect(readFileSync(join(cwd,"file.txt"),"utf8")).toBe("before\n");
});
it("rejects stale undo tokens and preserves the newer edit",async()=>{
 writeFileSync(join(cwd,"file.txt"),"first\n");const diff=await git.diff(cwd,["file.txt"]);
 writeFileSync(join(cwd,"file.txt"),"newer\n");await expect(git.mutate("task",cwd,{action:"discard",paths:["file.txt"],version:diff.version})).rejects.toThrow("已变化");expect(readFileSync(join(cwd,"file.txt"),"utf8")).toBe("newer\n");
});
it("explicit discard deletes only selected untracked files",async()=>{
 writeFileSync(join(cwd,"chosen.txt"),"chosen");writeFileSync(join(cwd,"keep.txt"),"keep");await act("discard",["chosen.txt"]);expect(existsSync(join(cwd,"chosen.txt"))).toBe(false);expect(existsSync(join(cwd,"keep.txt"))).toBe(true);
});
it("protects preexisting user edits and staged files from automatic commits",async()=>{
 writeFileSync(join(cwd,"file.txt"),"user\n");run("add","file.txt");await git.begin("task",cwd);writeFileSync(join(cwd,"file.txt"),"user plus agent\n");await expect(act("commit",["file.txt"],true)).rejects.toThrow("本轮开始前");expect(run("show",":file.txt")).toBe("user");
 git.release("task");await expect(act("commit",["file.txt"],true)).rejects.toThrow("缺少本轮");
});
it("allows verified clean-baseline changes to be automatically committed",async()=>{
 await git.begin("task",cwd);writeFileSync(join(cwd,"file.txt"),"agent\n");const state=await act("commit",["file.txt"],true);expect(state.files).toHaveLength(0);expect(state.commits[0]?.message).toBe("selected change");
});
it("creates branches without overwriting dirty files and switches only with a clean workspace",async()=>{
 writeFileSync(join(cwd,"file.txt"),"keep\n");expect((await git.mutate("task",cwd,{action:"create_branch",branch:"feature/test"},true)).branch).toBe("feature/test");
 await expect(git.mutate("task",cwd,{action:"switch_branch",branch:"main"},true)).rejects.toThrow("切换分支前");
 await act("commit",["file.txt"]);expect((await git.mutate("task",cwd,{action:"switch_branch",branch:"main"})).branch).toBe("main");expect(readFileSync(join(cwd,"file.txt"),"utf8")).toBe("before\n");
 await expect(git.mutate("task",cwd,{action:"create_branch",branch:"--force"})).rejects.toThrow("有效的分支");
});
it("rejects traversal, symlink escapes and files outside a nested project",async()=>{
 const nested=join(cwd,"nested");mkdirSync(nested);writeFileSync(join(nested,"a.txt"),"a");
 await expect(git.diff(cwd,["../outside.txt"])).rejects.toThrow("项目内");await expect(git.diff(nested,["file.txt"])).rejects.toThrow("超出当前项目");symlinkSync(join(cwd,"file.txt"),join(nested,"link.txt"));await expect(git.diff(nested,["nested/link.txt"])).rejects.toThrow("符号链接");
});
it("initializes a repository without automatically committing existing files",async()=>{
 rmSync(join(cwd,".git"),{recursive:true});await git.begin("task",cwd);expect((await git.mutate("task",cwd,{action:"init"},true)).head).toBeNull();run("config","user.name","Fixture");run("config","user.email","fixture@example.invalid");
 await expect(act("commit",["file.txt"],true)).rejects.toThrow("本轮开始前");writeFileSync(join(cwd,"agent.txt"),"created");await act("commit",["agent.txt"],true);expect(run("ls-tree","--name-only","HEAD")).toBe("agent.txt");
});
it("keeps history diff immutable and rejects arbitrary revision arguments",async()=>{
 const state=await git.status(cwd);expect((await git.diff(cwd,[],"all",state.head!)).text).toContain("initial");await expect(git.diff(cwd,[],"all","--output=bad")).rejects.toThrow("提交编号");
});

it("captures a lightweight baseline without loading history or branch listings",async()=>{
 writeFileSync(join(cwd,"file.txt"),"user before send\n");
 // begin must work even if the full panel query is unavailable.
 git.status = async()=>{throw new Error("full status must not run");};
 expect(await git.begin("task",cwd)).toMatchObject({available:true,root:realpathSync(cwd)});
});
