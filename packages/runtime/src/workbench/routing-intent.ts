/** Only explicit discussion + no-change requests are guarded here. Ordinary execution,
 * tests, read-only specialist checks and quoted button labels remain model-routed. */
export function isDiscussionOnlyRequest(text:string):boolean {
  const value=text.trim();
  if(!/^(?:(?:我想要?|我要|我们|请|帮我|麻烦|先|只|仅|暂时|一起)\s*){0,5}(?:讨论|比较|对比|分析|解释|评估|聊聊|梳理|讲讲|说明)/.test(value))return false;
  if(!/(?:暂时|本轮|现在|先)?(?:不要|别|不必|无需|不用|不进行|不做).{0,12}(?:修改|改动|更改|改|执行|运行|落地|实现|动手)/.test(value))return false;
  // Remove prohibitions, then look for any explicit subsequent request to do work.
  const positive=value.replace(/(?:暂时|本轮|现在|先)?(?:不要|别|不必|无需|不用|不进行|不做)[^，,。；;\n]*/g,'');
  if(positive.split(/[，,。；;\n]/).slice(1).some(clause=>/(?:修改|改动|更改|改|修复|实现|安装|创建|删除|运行|执行|提交|优化|测试|检查|核查)/.test(clause)))return false;
  return !/(?:然后|接着|并且|同时|顺便|再|现在|接下来|最后|之后|随后|后|并|请|帮我).{0,8}(?:修改|改动|更改|改|修复|实现|安装|创建|删除|运行|执行|提交|优化|测试|检查|核查)/.test(positive);
}
