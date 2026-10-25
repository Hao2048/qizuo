/**
 * npm 11 安装脚本策略回归（默认本机 registry；真实飞书包以 PIH_LIVE_NPM=1 单独启用）：
 * 经 npx/vitest 启动时用户 ~/.npmrc 的 allow-scripts 会被注入为 npm_config_* 环境变量，
 * 在 --prefix 项目化安装下触发 EALLOWSCRIPTS 硬拒——装不了带安装脚本的包（如飞书 cli）。
 * 回归点：安装期间摘除该变量后 @tunglam/pi-lark-cli 可装、CLI 可执行、变量装后恢复。
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { MarketService } from "./market-service.js";
import { Logger } from "../logging/logger.js";

describe("npm 脚本策略（飞书 cli 安装回归）", () => {
	it("本机 registry 验证安装、CLI、移除和 npm 环境恢复，不依赖外部网络", async () => {
    const dir=mkdtempSync(join(tmpdir(),'pih-npm-offline-'));
    const envKeys=['npm_config_allow_scripts','npm_config_registry','npm_config_audit','npm_config_fund'];
    const saved=new Map(envKeys.map(key=>[key,process.env[key]]));
    const name='pih-script-policy-fixture',source='npm:'+name;
    const pkg=join(dir,'fixture/package');mkdirSync(join(pkg,'bin'),{recursive:true});
    writeFileSync(join(pkg,'package.json'),JSON.stringify({name,version:'1.0.0',scripts:{install:'node -e "0"'},bin:{'fixture-cli':'bin/main.cjs'}}));
    writeFileSync(join(pkg,'bin/main.cjs'),"#!/usr/bin/env node\nconsole.log('fixture-cli 1.0.0');\n",{mode:0o755});
    const tarball=join(dir,'fixture.tgz');execFileSync('tar',['-czf',tarball,'-C',join(dir,'fixture'),'package']);
    const bytes=readFileSync(tarball);let registry='';
    const server=createServer((req,res)=>{
      if(req.url==='/fixture.tgz'){res.setHeader('content-type','application/octet-stream');res.end(bytes);return;}
      if(req.url?.startsWith('/'+name)){res.setHeader('content-type','application/json');res.end(JSON.stringify({name,'dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name,version:'1.0.0',scripts:{install:'node -e "0"'},dist:{tarball:registry+'/fixture.tgz'}}}}));return;}
      res.writeHead(404);res.end();
    });
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));registry=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try {
      process.env.npm_config_allow_scripts='@larksuite/cli';process.env.npm_config_registry=registry;process.env.npm_config_audit='false';process.env.npm_config_fund='false';
      const svc=await MarketService.create({cwd:dir,agentDir:join(dir,'pi'),logger:new Logger(),emit:()=>{},getVisibility:()=> 'public',setVisibilityRow:()=>{}});
      const result=await svc.installFromNpm(name);expect(result.ok,result.message).toBe(true);
      const installed=join(dir,'pi/npm/node_modules',name);
      expect(execFileSync('node',[join(installed,'bin/main.cjs'),'--version'],{encoding:'utf8'})).toContain('fixture-cli 1.0.0');
      expect(process.env.npm_config_allow_scripts).toBe('@larksuite/cli');
      expect((await svc.remove(source)).ok).toBe(true);
      expect(JSON.parse(readFileSync(join(dir,'pi/settings.json'),'utf8')).packages).not.toContain(source);
      expect((await svc.remove(source)).ok).toBe(false);
      expect(process.env.npm_config_allow_scripts).toBe('@larksuite/cli');
    } finally {
      for(const [key,value]of saved){if(value===undefined)delete process.env[key];else process.env[key]=value;}
      server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});
    }
  },30000);
	it.skipIf(process.env.PIH_LIVE_NPM!=='1')("官方飞书 npm 源实际下载安装验收（PIH_LIVE_NPM=1）", async () => {
		process.env.npm_config_allow_scripts = "@larksuite/cli";
		const dir = mkdtempSync(join(tmpdir(), "pih-scp-"));
		try {
			const svc = await MarketService.create({
				cwd: dir,
				agentDir: join(dir, "pi"),
				logger: new Logger(),
				emit: () => {},
				getVisibility: () => "public",
				setVisibilityRow: () => {},
			});
			const r = await svc.installFromNpm("@tunglam/pi-lark-cli");
			expect(r.ok, r.message ?? "").toBe(true);
			const pkgDir = join(dir, "pi/npm/node_modules/@tunglam/pi-lark-cli");
			expect(existsSync(pkgDir)).toBe(true);
			// 捆绑的官方 lark CLI 可执行
			const version = execFileSync("node", [join(pkgDir, "bin/main.cjs"), "--version"], { encoding: "utf8" });
			expect(version).toContain("lark-cli");

			// 移除回归：npm: 规格原样透传（历史缺陷：resolve() 拼成本地路径导致"移除成功"实则未生效）
			const rm = await svc.remove("npm:@tunglam/pi-lark-cli");
			expect(rm.ok, JSON.stringify(rm)).toBe(true);
			const settings = JSON.parse(readFileSync(join(dir, "pi/settings.json"), "utf8")) as { packages?: string[] };
			expect(settings.packages?.some((x) => x.includes("pi-lark-cli"))).toBe(false);
			// 再移除同规格：如实报告未命中
			const rm2 = await svc.remove("npm:@tunglam/pi-lark-cli");
			expect(rm2.ok).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			expect(process.env.npm_config_allow_scripts).toBe("@larksuite/cli");
			delete process.env.npm_config_allow_scripts;
		}
	}, 300_000);
});
