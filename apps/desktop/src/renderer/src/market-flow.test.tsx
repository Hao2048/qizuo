import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import MarketContext from "./panels/MarketContext.js";
import MarketDetail from "./panels/MarketDetail.js";
import { useStore } from "./store.js";
import type { PiHBridge } from "./api.js";

beforeEach(() => { useStore.setState({ marketTab: "plugins", pluginsSource: "pi", skillsSource: "claude" }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function bridge(override?: (command: string, payload: any) => unknown) {
 const invoke = vi.fn(async (command: string, payload: any) => {
 const replaced = override?.(command, payload);
 if (replaced !== undefined) return { ok: true, result: await replaced };
 const defaults: Record<string, unknown> = {
 "market:list": { packages: [], localSkills: [], localExtensions: [] }, "mcp:list": { servers: [] },
 "market:listPi": { items: [{ name: "@amaster.ai/pi-lark", description: "飞书工具", source: "npm:@amaster.ai/pi-lark", downloads: 2000 }] },
 "market:listClaude": { items: [{ name: "github", description: "GitHub tools", kind: "mcp-plugin", fallback: false }, { name: "native-only", description: "Claude hooks", installable: false, compatibility: "Claude Hook 暂不支持" }], fallbackSource: false },
 "market:recommend": { items: [], generatedAt: 1, nextRefreshAt: 604800001, note: "每周推荐" },
 "market:installNpm": { ok: true }, "market:installClaude": { ok: true, files: [] },
 "market:authInfo": { source: payload?.source, kind: "none", status: "ready", servers: [] }, "sys:openExternal": { ok: true }, "mcp:setCredential": { ok: true },
 };
 return { ok: true, result: defaults[command] };
 });
 window.pih = { invoke, onEvent: () => () => {}, platform: "darwin", versions: { electron: "test", chrome: "test" } };
 return invoke;
}
describe("market sources and authentication", () => {
 it("automatically loads weekly recommendations and directory by source and type", async () => {
 const invoke = bridge(); render(<><MarketContext/><MarketDetail /></>);
 await screen.findByText("@amaster.ai/pi-lark");
 expect(invoke).toHaveBeenCalledWith("market:recommend", { source: "pi", kind: "plugins" });
 expect(screen.getByRole("region", { name: "每周推荐" }).compareDocumentPosition(screen.getByRole("region", { name: "浏览目录" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Claude 官方" })); await screen.findByText("github");
 expect(invoke).toHaveBeenCalledWith("market:listClaude", { query: undefined, kind: "plugins" });
 expect(invoke).toHaveBeenCalledWith("market:recommend", { source: "claude", kind: "plugins" });
 useStore.setState({ marketTab: "skills", skillsSource: "pi" }); await screen.findByRole("heading", { name: "浏览技能" });
 await waitFor(() => expect(invoke).toHaveBeenCalledWith("market:listPi", { query: undefined, kind: "skills" }));
 });
 it("ignores a slow response from the previous source", async () => {
 let resolvePi!: (value: unknown) => void;
 const pending = new Promise(resolve => { resolvePi = resolve; });
 bridge(command => command === "market:listPi" ? pending : undefined); render(<><MarketContext/><MarketDetail /></>);
 fireEvent.click(screen.getByRole("button", { name: "Claude 官方" })); await screen.findByText("github");
 resolvePi({ items: [{ name: "stale-pi-result", downloads: null }] });
 await waitFor(() => expect(screen.queryByText("stale-pi-result")).toBeNull());
 expect(screen.getByText("github")).toBeTruthy();
 });
 it("installing Lark opens auth guide automatically and starts browser authorization with one click", async () => {
 const invoke = bridge((command, payload) => command === "market:authInfo" ? { source: payload.source, kind: "lark", status: "required", servers: [] } : command === "market:authStart" ? { source: payload.source, kind: "lark", status: "working", message: "请完成浏览器授权", servers: [] } : undefined);
 render(<><MarketContext/><MarketDetail /></>); const card = (await screen.findByText("@amaster.ai/pi-lark")).closest(".mkt-card")!;
 fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "安装" }));
 expect(await screen.findByRole("dialog", { name: "飞书认证" })).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "开始认证" }));
 await waitFor(() => expect(invoke).toHaveBeenCalledWith("market:authStart", { source: "npm:@amaster.ai/pi-lark" }));
 expect(await screen.findByRole("button", { name: "等待浏览器授权…" })).toHaveProperty("disabled", true);
 });
 it("key-only services keep protected manual input behind advanced configuration", async () => {
 const invoke = bridge((command, payload) => command === "market:authInfo" ? { source: payload.source, kind: "token", status: "required", servers: [{ name: "github", kind: "http", authVars: ["GITHUB_PERSONAL_ACCESS_TOKEN"], missingVars: ["GITHUB_PERSONAL_ACCESS_TOKEN"] }] } : undefined);
 render(<><MarketContext/><MarketDetail /></>); fireEvent.click(screen.getByRole("button", { name: "Claude 官方" }));
 const card = (await screen.findByText("github")).closest(".mkt-card")!; fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "安装" }));
 await screen.findByRole("button", { name: "高级配置 · 服务密钥" });
 expect(screen.queryByPlaceholderText("粘贴令牌…")).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "高级配置 · 服务密钥" }));
 const modal = await screen.findByRole("dialog", { name: "配置令牌 · github" });
 const save = within(modal).getByRole("button", { name: "保存" }); expect(save).toHaveProperty("disabled", true);
 const field = within(modal).getByPlaceholderText("粘贴令牌…"); expect(field.getAttribute("type")).toBe("password");
 fireEvent.change(field, { target: { value: "fake-token" } }); fireEvent.click(save);
 await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp:setCredential", { varName: "GITHUB_PERSONAL_ACCESS_TOKEN", value: "fake-token" }));
 });
 it("unsupported native plugins cannot be installed and auth lookup failure preserves installation success", async () => {
 bridge(command => command === "market:authInfo" ? Promise.reject(new Error("offline")) : undefined);
 render(<><MarketContext/><MarketDetail /></>); fireEvent.click(screen.getByRole("button", { name: "Claude 官方" }));
 const native = (await screen.findByText("native-only")).closest(".mkt-card")!; expect(within(native as HTMLElement).getByRole("button", { name: "暂不支持" })).toHaveProperty("disabled", true);
 const card = (await screen.findByText("github")).closest(".mkt-card")!; fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "安装" }));
 expect(await screen.findByText(/已安装 github；认证信息暂不可用/)).toBeTruthy(); expect(screen.queryByText(/安装失败/)).toBeNull();
 });
});

it("GitHub installation opens browser authorization and displays only the ephemeral device code", async () => {
 const invoke = bridge((command,payload) => command === "market:authInfo" ? {source:payload.source,kind:"oauth",status:"required",servers:[]} : command === "market:authStart" ? {source:payload.source,kind:"oauth",status:"working",verificationCode:"ABCD-1234",url:"https://github.com/login/device",servers:[]} : undefined);
 render(<><MarketContext/><MarketDetail /></>); fireEvent.click(screen.getByRole("button",{name:"Claude 官方"}));
 const card=(await screen.findByText("github")).closest(".mkt-card")!;
 fireEvent.click(within(card as HTMLElement).getByRole("button",{name:"安装"}));
 await screen.findByRole("dialog",{name:"GitHub 认证"});
 expect(screen.queryByPlaceholderText("粘贴令牌…")).toBeNull();
 fireEvent.click(await screen.findByRole("button",{name:"开始认证"}));
 expect(await screen.findByText("ABCD-1234")).toBeTruthy();
 expect(invoke).toHaveBeenCalledWith("market:authStart",{source:"claude:github"});
 expect(invoke).not.toHaveBeenCalledWith("mcp:setCredential",expect.anything());
});

it("installation with a verified reused login goes directly to usable status without an auth dialog",async()=>{
 const invoke=bridge((command,payload)=>command==="market:authInfo"?{source:payload.source,kind:"oauth",status:"ready",message:"已复用 GitHub 登录（fixture-user），插件连接及工具访问已验证。",servers:[]}:undefined);
 render(<><MarketContext/><MarketDetail /></>);fireEvent.click(screen.getByRole("button",{name:"Claude 官方"}));
 const card=(await screen.findByText("github")).closest(".mkt-card")!;
 fireEvent.click(within(card as HTMLElement).getByRole("button",{name:"安装"}));
 expect(await screen.findByText(/已安装 github。已复用 GitHub 登录/)).toBeTruthy();
 expect(screen.queryByRole("dialog")).toBeNull();expect(invoke).not.toHaveBeenCalledWith("market:authStart",expect.anything());
});

it("cancels the matching install, waits for cleanup and never opens authentication", async () => {
	let finish!: (value: unknown) => void;
	const invoke = bridge((command) => command === "market:installNpm" ? new Promise(resolve => { finish = resolve; }) : command === "market:cancelInstall" ? {ok:true} : undefined);
	render(<><MarketContext/><MarketDetail /></>);
	const card = (await screen.findByText("@amaster.ai/pi-lark")).closest(".mkt-card")!;
	fireEvent.click(within(card as HTMLElement).getByRole("button", {name:"安装"}));
	const call = invoke.mock.calls.find(([command]) => command === "market:installNpm")!;
	expect(call[1].operationId).toEqual(expect.any(String));
	fireEvent.click(await screen.findByRole("button", {name:"取消安装"}));
	await waitFor(() => expect(invoke).toHaveBeenCalledWith("market:cancelInstall", {operationId:call[1].operationId}));
	expect(await screen.findByRole("button", {name:"正在取消…"})).toHaveProperty("disabled", true);
	finish({ok:false,message:"已取消安装"});
	expect(await screen.findByText("已取消安装")).toBeTruthy();
	expect(screen.queryByRole("button", {name:"正在取消…"})).toBeNull();
	expect(invoke).not.toHaveBeenCalledWith("market:authInfo", expect.anything());
	expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps the installation result when cancellation is refused during publication", async () => {
	let finish!: (value: unknown) => void;
	bridge(command => command === "market:installNpm" ? new Promise(resolve => { finish = resolve; }) : command === "market:cancelInstall" ? {ok:false} : undefined);
	render(<><MarketContext/><MarketDetail /></>);
	const card = (await screen.findByText("@amaster.ai/pi-lark")).closest(".mkt-card")!;
	fireEvent.click(within(card as HTMLElement).getByRole("button", {name:"安装"}));
	fireEvent.click(await screen.findByRole("button", {name:"取消安装"}));
	expect(await screen.findByRole("button", {name:"正在完成…"})).toHaveProperty("disabled", true);
	finish({ok:false,message:"fixture failure"});
	expect(await screen.findByText("安装失败：fixture failure")).toBeTruthy();
});

it("全部来源合并两个目录，安装时保留各自的源",async()=>{
 const call=bridge();useStore.setState({pluginsSource:"all"});render(<><MarketContext/><MarketDetail/></>);
 const pi=(await screen.findByText("@amaster.ai/pi-lark")).closest('.mkt-card')!;await screen.findByText('github');
 expect(call).toHaveBeenCalledWith('market:listPi',{query:undefined,kind:'plugins'});expect(call).toHaveBeenCalledWith('market:listClaude',{query:undefined,kind:'plugins'});
 fireEvent.click(within(pi as HTMLElement).getByRole('button',{name:'安装'}));await waitFor(()=>expect(call).toHaveBeenCalledWith('market:installNpm',expect.objectContaining({spec:'@amaster.ai/pi-lark'})));
});
it("全部来源中一个目录失败仍可浏览另一个目录",async()=>{
 bridge(command=>command==='market:listClaude'?Promise.reject(Error('unavailable')):undefined);useStore.setState({pluginsSource:'all'});render(<><MarketContext/><MarketDetail/></>);await screen.findByText('@amaster.ai/pi-lark');expect(await screen.findByText(/部分来源加载失败/)).toBeTruthy();expect(screen.getByRole('button',{name:'全部来源'})).toHaveProperty('ariaPressed','true');
});
