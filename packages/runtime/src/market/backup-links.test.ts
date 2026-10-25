import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync,symlinkSync,readlinkSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHarnessCore,type HarnessCore} from '../core/harness-core.js';
import {BackupService} from './backup-service.js';
let dir:string,core:HarnessCore;
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'pih-backup-links-'));core=await createHarnessCore({dataDir:dir,enableFaux:true});});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
it('backs up and restores a top-level dangling relative symlink without following or rewriting its target',async()=>{
 symlinkSync('missing-target',join(dir,'link'));mkdirSync(join(dir,'fixtures'));writeFileSync(join(dir,'fixtures/keep.txt'),'original');
 const backup=core.backup.create();expect(readlinkSync(join(backup.path,'link'))).toBe('missing-target');
 const listed=await core.router.invoke('backup:list',{});expect(listed.ok).toBe(true);if(listed.ok)expect((listed.result as {backups:Array<{createdAt:number}>}).backups.every(b=>Number.isInteger(b.createdAt))).toBe(true);
 expect(core.backup.requestRestore(backup.id).ok).toBe(true);await core.shutdown();writeFileSync(join(dir,'fixtures/keep.txt'),'changed');
 expect(BackupService.executePendingRestore(dir)).toBe(true);expect(readlinkSync(join(dir,'link'))).toBe('missing-target');expect(readFileSync(join(dir,'fixtures/keep.txt'),'utf8')).toBe('original');core=await createHarnessCore({dataDir:dir,enableFaux:true});
});
