import{test}from'node:test';import assert from'node:assert/strict';import{isAiFileReview}from'./review-method.mjs';
test('allows explicit AI review labels and explicit denials of human acceptance',()=>{
 for(const s of ['AI 文件审阅','AI文件审阅（静态逐文件阅读与交叉比对，非真人验收，非程序自动检查通过）','AI 文件审阅，未进行真人验收','AI 文件审阅，没有人工评审'])assert.equal(isAiFileReview(s),true,s);
});
test('still rejects human impersonation, mixed positive human claims, and missing AI labels',()=>{
 for(const s of ['真人验收','人工逐节审阅','AI文件审阅+真人验收','AI文件审阅，非真人验收；另有人工评审','AI文件审阅与手工审阅',undefined,''])assert.equal(isAiFileReview(s),false,String(s));
});
