import { beforeEach, afterEach } from 'vitest';
beforeEach(async()=>{
 const drafts=await import('./src/draft-persistence.js');
 await drafts.flushAllDrafts().catch(()=>{});
 drafts.resetDraftPersistence();
});
afterEach(async()=>{
 const drafts=await import('./src/draft-persistence.js');
 await drafts.flushAllDrafts().catch(()=>{});
});
