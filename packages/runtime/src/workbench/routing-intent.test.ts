import {expect,it} from 'vitest';
import {isDiscussionOnlyRequest} from './routing-intent.js';
it('guards explicit discussion-only requests without blocking new execution or tests',()=>{
 for(const text of ['先比较两个字段的迁移成本，先别修改约定和代码。','先讨论官网有哪些栏目，暂时别改文件。','请分析两种方案，不要执行。'])expect(isDiscussionOnlyRequest(text)).toBe(true);
 for(const text of ['请把按钮文案修改为“先别修改代码”。','只修改前端，不要修改后端。','先比较方案，然后修改前端，别改后端。','先讨论方案，然后运行测试，不要修改文件。','请前端只读核查接口，不要修改文件。','比较两种方案后请执行选定方案。','先比较方案，不要修改接口，最后修复按钮。','先讨论，不要改后端，只把前端按钮改好。','先讨论文案，再把页面上的提交按钮改为发送咨询；不要改接口。'])expect(isDiscussionOnlyRequest(text)).toBe(false);
});
