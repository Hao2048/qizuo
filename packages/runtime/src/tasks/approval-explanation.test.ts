import {expect,it} from "vitest";
import {explainToolApproval as explain} from "./approval-explanation.js";
it("describes literal deletion, writes and quoted file paths without surfacing raw code",()=>{
 expect(explain("bash",{command:'rm -rf "old drafts"'},"/project")).toEqual({summary:"删除文件或文件夹",effects:["/project/old drafts","直接删除，不会移到废纸篓。"]});
 expect(explain("write",{path:"a.txt",content:"secret"},"/project")).toEqual({summary:"写入文件",effects:["/project/a.txt","如果文件已存在，将覆盖其内容。"]});
 expect(explain("bash",{command:'mv "a b" out'},"/project").effects).toContain("目标：/project/out");
});
it("never presents dynamic commands, mutation flags or mixed operations as harmless reads",()=>{
 for(const command of ['cat a; rm b','ls $(rm file)','find . -delete','sed -i x file','open -a Terminal','cat a > b','python3 -c "run()"','cat a\\ b'])expect(explain("bash",{command},"/project").summary).not.toBe("读取文件");
 expect(explain("bash",{command:'ls -la'},"/project")).toMatchObject({summary:"查看文件夹",effects:["/project"]});
});
it('explains scheduled memory creation in human terms without exposing only a tool name',()=>{
 const result=explain('save_time_memory',{title:'整理事项',instructions:'整理项目待办',rule:{kind:'once',at:'2030-01-02T09:00:00+08:00'}});
 expect(result.summary).toBe('创建角色定时任务');expect(result.effects?.join(' ')).toContain('2030-01-02');expect(result.effects?.join(' ')).toContain('错过不补跑');
});
