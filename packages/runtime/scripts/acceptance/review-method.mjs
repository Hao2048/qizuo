/** Acceptance-only label check; not proof of who actually performed the review. */
export function isAiFileReview(method) {
 if(typeof method!=='string'||!/^\s*AI\s*(?:文件)?\s*(?:审阅|评审|检查)/.test(method))return false;
 // Remove only explicit, local negations; a separate positive human claim still fails.
 const remaining=method.replace(/(?:非|不是|并非|未进行|未经|没有进行|没有)\s*(?:真人(?:验收|确认|评审)?|人工逐节(?:审阅|检查)?|人工评审|手工审阅)/g,'');
 return !/人工逐节|人工评审|真人|手工审阅/.test(remaining);
}
