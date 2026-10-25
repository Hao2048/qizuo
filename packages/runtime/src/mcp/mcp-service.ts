import { createHash, randomUUID } from "node:crypto";
/**
 * McpService：agentDir/mcp.json 的用户级 MCP 服务器配置 CRUD。
 * 会话接入由 AgentFactory 的 createMcpExtension 完成（读取同一文件）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync,renameSync,rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServerInfo } from "@pi-harness/contracts";

/** 不允许经令牌配置写入的关键环境变量（劫持加载器/解释器/进程族） */
const DANGEROUS_ENV_VARS = new Set([
	"PATH", "NODE_OPTIONS", "NODE_PATH", "NODE_PRELOAD", "LD_PRELOAD", "LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "HOME", "SHELL", "IFS", "PYTHONPATH",
	"PYTHONHOME", "RUBYOPT", "PERL5OPT", "BASH_ENV", "ENV", "SHELLOPTS", "CDPATH",
]);

interface ServerEntry {
	exposure?: string;
	command?: string;
	args?: string[];
	url?: string;
	env?: Record<string, string>;
	description?: string;
	enabled?: boolean;
	[type: string]: unknown;
	headers?: Record<string, string>;
}

type McpConfig = { mcpServers?: Record<string, ServerEntry> };

/** 从服务器配置（headers/env/url/args）里提取 ${VAR} 占位符名 */
function detectAuthVars(entry: ServerEntry): string[] {
	const vars = new Set<string>();
	const scan = (value: unknown): void => {
		if (typeof value !== "string") return;
		for (const m of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) vars.add(m[1]!);
	};
	for (const v of Object.values(entry.headers ?? {})) scan(v);
 if (entry["oauth"] && typeof entry["oauth"] === "object") for (const v of Object.values(entry["oauth"])) scan(v);
	for (const v of Object.values(entry.env ?? {})) scan(v);
	scan(entry.url);
	for (const a of entry.args ?? []) scan(a);
	return [...vars].sort();
}

export class McpService {
	#path: string;
	#credPath: string;

	constructor(agentDir: string) {
		this.#path = join(agentDir, "mcp.json");
		this.#credPath = join(agentDir, "mcp-credentials.json");
		// 启动即注入：pi 在本进程内解析 ${VAR}，凭据需进入 process.env
		for (const [k, v] of Object.entries(this.#readCredentials())) {
			if (typeof v === "string" && v && process.env[k] === undefined) process.env[k] = v;
		}
	}

	get path(): string {
		return this.#path;
	}

 resourcePolicy(name:string):{exclusive:boolean;resourceGroup:string;resourceKey:string}{
  const entry=this.#read().mcpServers?.[name];if(!entry)throw Error("MCP 服务器不存在");
  const group=entry["resourceGroup"];
  const shared=typeof group==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(group)?group:undefined;
  let endpoint=name;
  if(entry.url){try{const url=new URL(entry.url);endpoint=url.origin+url.pathname.replace(/\/$/,'');}catch{endpoint=name;}}
  const resourceKey=shared?'group:'+shared:'server:'+createHash('sha256').update(endpoint).digest('hex');
  return {exclusive:entry["exclusive"]!==false,resourceGroup:shared??name,resourceKey};
 }
 setResourcePolicy(name:string,exclusive:boolean,resourceGroup:string):boolean{
  if(typeof exclusive!=='boolean'||!/^[A-Za-z0-9_-]{0,64}$/.test(resourceGroup))throw Error("资源组名称无效");
  const config=this.#read(),entry=config.mcpServers?.[name];if(!entry)throw Error("MCP 服务器不存在");
  entry['exclusive']=exclusive;
  if(resourceGroup)entry['resourceGroup']=resourceGroup;else delete entry['resourceGroup'];
  this.#write(config);return true;
 }

	#read(strict = false): McpConfig {
		if (!existsSync(this.#path)) return {};
		try {
            const config = JSON.parse(readFileSync(this.#path, "utf8"));
            const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
            if (!object(config) || (config.mcpServers !== undefined && (!object(config.mcpServers) || Object.values(config.mcpServers).some(entry => !object(entry) ||
                ["command", "url", "description"].some(k => entry[k] !== undefined && typeof entry[k] !== "string") ||
                (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(v => typeof v !== "string"))) ||
                ["headers", "env"].some(k => entry[k] !== undefined && (!object(entry[k]) || Object.values(entry[k]).some(v => typeof v !== "string"))))))) throw Error("invalid config");
            return config as McpConfig;
		} catch {
            if (strict) throw Error("MCP 配置文件损坏或格式无效，原文件已保留；请修复或恢复备份后再保存。");
			return {};
		}
	}

	#write(config: McpConfig): void {
        this.#read(true);
		mkdirSync(dirname(this.#path), { recursive: true });
		const temporary=`${this.#path}.${randomUUID()}.tmp`;
        try{writeFileSync(temporary,JSON.stringify(config,null,"\t"),{mode:0o600});renameSync(temporary,this.#path);}
        finally{rmSync(temporary,{force:true});}
	}

	list(): McpServerInfo[] {
		const config = this.#read();
		return Object.entries(config.mcpServers ?? {}).map(([name, entry]) => {
			const authVars = detectAuthVars(entry);
			const missingVars = authVars.filter((v) => !process.env[v]);
			return {
				name,
				kind: entry.url ? ("http" as const) : ("stdio" as const),
				command: entry.command ?? null,
				args: entry.args,
				url: entry.url ?? null,
				description: entry.description ?? null,
				enabled: entry.enabled !== false,
				authVars,
				missingVars,
                ...(typeof entry['exclusive']==='boolean'?{exclusive:entry['exclusive']}:{}),
                ...(typeof entry['resourceGroup']==='string'?{resourceGroup:entry['resourceGroup']}:{}),
			};
		});
	}

    /** Authorization headers use static credentials; other remote servers may use browser OAuth. */
    supportsBrowserAuth(name: string): boolean {
        const entry = this.#read().mcpServers?.[name];
        return !!entry?.url && !Object.keys(entry.headers ?? {}).some(header => header.toLowerCase() === "authorization");
    }

    /** GitHub's official endpoint accepts the token acquired by the official GitHub CLI. */
    githubCredential(name: string): string | undefined {
        const entry = this.#read().mcpServers?.[name];
        if (!entry?.url) return undefined;
        try {
            const url = new URL(entry.url);
            if (url.origin !== "https://api.githubcopilot.com" || !/^\/mcp\/?$/.test(url.pathname) || url.search || url.username || url.password) return undefined;
        } catch { return undefined; }
        const auth = Object.entries(entry.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1];
        const variable = auth?.match(/^Bearer \$\{(GITHUB_PERSONAL_ACCESS_TOKEN|GITHUB_TOKEN|GH_TOKEN)\}$/i)?.[1];
        return variable;
    }

    /** Switch a static bearer placeholder to OAuth only after the service advertises it. */
    async prepareBrowserAuth(name: string): Promise<boolean> {
        if (this.supportsBrowserAuth(name)) return true;
        const original = this.#read().mcpServers?.[name];
        if (!original?.url || this.githubCredential(name)) return false;
        const header = Object.keys(original.headers ?? {}).find(key => key.toLowerCase() === "authorization");
        if (!header || !/^Bearer \$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(original.headers![header]!)) return false;
        try {
            const url = new URL(original.url); if (url.protocol !== "https:" || url.username || url.password) return false;
            const signal = AbortSignal.timeout(10_000);
            const response = await fetch(url, { signal, redirect: "error" });
            const hint = response.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1];
            const paths = [hint, `${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/$/, "")}`, `${url.origin}/.well-known/oauth-protected-resource`].filter((value): value is string => !!value);
            for (const path of [...new Set(paths)]) {
                const metadataUrl = new URL(path);
                if (metadataUrl.origin !== url.origin || metadataUrl.protocol !== "https:") continue;
                const result = await fetch(metadataUrl, { signal, redirect: "error" });
                if (!result.ok) continue;
                const metadata = await result.json() as { resource?: string; authorization_servers?: string[] };
                const resource = new URL(metadata.resource ?? "");
                if (resource.origin !== url.origin || !url.pathname.startsWith(resource.pathname) || !metadata.authorization_servers?.length || !metadata.authorization_servers.every(server => new URL(server).protocol === "https:")) continue;
                const settings = original.oauth as { clientId?: string; clientName?: string; clientRegistration?: string; callbackUrl?: string } | undefined;
                let registerable = !!settings?.clientId;
                let useCimd = false;
                // Advertising OAuth alone is insufficient: this host also needs a usable client registration.
                for (const server of metadata.authorization_servers.slice(0, 3)) {
                    if (registerable) break;
                    const issuer = new URL(server);
                    const discovery = new URL(`/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, "")}`, issuer.origin);
                    const authResponse = await fetch(discovery, { signal, redirect: "error" });
                    if (!authResponse.ok) continue;
                    const auth = await authResponse.json() as { registration_endpoint?: string; client_id_metadata_document_supported?: boolean; token_endpoint_auth_methods_supported?: string[] };
                    const dcr = !!(auth.registration_endpoint && new URL(auth.registration_endpoint).protocol === "https:");
                    const callback = new URL(settings?.callbackUrl ?? "http://127.0.0.1/callback");
                    const cimd = auth.client_id_metadata_document_supported === true && auth.token_endpoint_auth_methods_supported?.includes("none") && !settings?.clientName && ["127.0.0.1", "localhost"].includes(callback.hostname) && callback.pathname === "/callback";
                    registerable = !!(settings?.clientRegistration === "cimd" ? cimd : dcr || cimd);
                    useCimd = registerable && (!dcr || settings?.clientRegistration === "cimd");
                }
                if (!registerable) continue;
                const config = this.#read(); const entry = config.mcpServers?.[name];
                if (JSON.stringify(entry) !== JSON.stringify(original)) return false; // User edited while discovery was in flight.
                entry!.pihStaticAuthorization = { [header]: entry!.headers![header] };
                delete entry!.headers![header];
                if (useCimd) entry!.oauth = { ...(entry!.oauth as Record<string, unknown> ?? {}), clientRegistration: "cimd", callbackUrl: settings?.callbackUrl ?? "http://127.0.0.1/callback" };
                this.#write(config); return true;
            }
        } catch { /* Unsupported or unavailable: preserve the existing working configuration. */ }
        return false;
    }

	/* ---------------- 令牌凭据（${VAR} 占位符的取值，0600 落盘 + 注入 process.env） ---------------- */

	#readCredentials(strict = false): Record<string, string> {
		if (!existsSync(this.#credPath)) return {};
		try {
            const map = JSON.parse(readFileSync(this.#credPath, "utf8"));
            if (!map || typeof map !== "object" || Array.isArray(map) || Object.values(map).some(value => typeof value !== "string")) throw Error("invalid credentials");
            return map;
		} catch {
            if (strict) throw Error("MCP 凭据文件损坏或格式无效，原文件已保留；请修复或恢复备份后再保存。");
			return {};
		}
	}

	#writeCredentials(map: Record<string, string>): void {
        this.#readCredentials(true);
		mkdirSync(dirname(this.#credPath), { recursive: true });
        const temporary = `${this.#credPath}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temporary, JSON.stringify(map, null, "\t"), { mode: 0o600, encoding: "utf8" });
            renameSync(temporary, this.#credPath);
        } finally { rmSync(temporary, {force:true}); }
	}

	/** 写入/更新一个令牌：落盘并即时注入当前进程（pi 在本进程解析 ${VAR}）。 */
	setCredential(varName: string, value: string): { ok: boolean; message?: string } {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) return { ok: false, message: "非法变量名" };
		if (!value.trim()) return { ok: false, message: "令牌不能为空" };
		// 关键环境变量被写入会劫持后续所有子进程（加载器/解释器路径），拒绝
		if (DANGEROUS_ENV_VARS.has(varName)) return { ok: false, message: `不允许写入关键环境变量：${varName}` };
		const map = {...this.#readCredentials(true), [varName]: value.trim()};
		this.#writeCredentials(map);
		process.env[varName] = value.trim();
		return { ok: true };
	}

	/** 清除一个令牌（文件与进程环境都移除）。 */
	clearCredential(varName: string): boolean {
		const map = this.#readCredentials(true);
		if (!Object.hasOwn(map, varName)) return false;
		delete map[varName];
		this.#writeCredentials(map);
		delete process.env[varName];
		return true;
	}

	/** 凭据文件里已配置的变量名（不含取值——取值不出服务端）。 */
	configuredVars(): string[] {
		return Object.keys(this.#readCredentials()).sort();
	}

	add(input: {
		name: string;
		command?: string;
		args?: string[];
		url?: string;
		env?: Record<string, string>;
		headers?: Record<string, string>;
        oauth?: Record<string, unknown>;
		description?: string;
	}): McpServerInfo {
		if (!input.command && !input.url) throw new Error("必须提供 command（stdio）或 url（http）之一");
		const config = this.#read();
		config.mcpServers = config.mcpServers ?? {};
		if (config.mcpServers[input.name]) throw new Error(`同名服务器已存在: ${input.name}`);
		config.mcpServers[input.name] = this.#entryOf(input);
		this.#write(config);
		return this.list().find((s) => s.name === input.name)!;
	}

	/** 插件安装等幂等场景：存在则整体覆盖为最新配置 */
	upsert(input: Parameters<McpService["add"]>[0]): McpServerInfo {
        return this.upsertMany([input])[0]!;
    }

    /** Validate the whole plugin before publishing a single config revision. */
    prepareUpsertMany(inputs:Array<Parameters<McpService["add"]>[0]>):string {
        const names=new Set<string>();
        for(const input of inputs){
            if(!/^[A-Za-z0-9_-]{1,64}$/.test(input.name) || names.has(input.name))throw new Error("插件服务器名称无效或重复。");
            names.add(input.name);
            if(!input.command?.trim() && !input.url?.trim())throw new Error("必须提供 command（stdio）或 url（http）之一");
            if(input.args && (!Array.isArray(input.args) || input.args.some(v=>typeof v!=="string")))throw new Error("插件服务器 args 必须是字符串数组。");
            for(const map of [input.env,input.headers])if(map && (typeof map!=="object" || Array.isArray(map) || Object.values(map).some(v=>typeof v!=="string")))throw new Error("插件服务器 env/headers 必须是字符串字典。");
        }
        const config=this.#read(true);
        config.mcpServers ??={};
        for(const input of inputs){
            const previous=config.mcpServers[input.name];
            config.mcpServers[input.name]={...this.#entryOf(input),...(typeof previous?.exclusive==='boolean'?{exclusive:previous.exclusive}:{}),...(typeof previous?.resourceGroup==='string'?{resourceGroup:previous.resourceGroup}:{})};
        }
        return JSON.stringify(config,null,"\t");
    }

    upsertMany(inputs:Array<Parameters<McpService["add"]>[0]>):McpServerInfo[] {
        if(!inputs.length)return [];
        this.#write(JSON.parse(this.prepareUpsertMany(inputs)));
        const names=new Set(inputs.map(input=>input.name));
        return this.list().filter(server=>names.has(server.name));
    }

	#entryOf(input: Parameters<McpService["add"]>[0]): ServerEntry {
		const entry: ServerEntry = {};
		// harness 场景默认 direct：工具直接对模型可见可调用（pi 默认 codemode 不声明给模型）
		entry.exposure = "direct";
		if (input.command) {
			entry.command = input.command;
			if (input.args) entry.args = input.args;
		}
		if (input.url) entry.url = input.url;
		if (input.env) entry.env = input.env;
		if (input.headers) entry.headers = input.headers;
        if (input.oauth) entry["oauth"] = input.oauth;
		if (input.description) entry.description = input.description;
		return entry;
	}

	remove(name: string): boolean {
		const config = this.#read();
		if (!config.mcpServers?.[name]) return false;
		delete config.mcpServers[name];
		this.#write(config);
		return true;
	}

	setEnabled(name: string, enabled: boolean): boolean {
		const config = this.#read();
		const entry = config.mcpServers?.[name];
		if (!entry) return false;
		entry.enabled = enabled;
		this.#write(config);
		return true;
	}
}
