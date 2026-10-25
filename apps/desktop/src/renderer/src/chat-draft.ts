import { useEffect } from 'react';
import { EMPTY_COMPOSER_DRAFT, type Attachment, type DraftTarget } from '@pi-harness/contracts';
import { draftKey, retainDraft, loadDraft, patchDraft, useDrafts } from './draft-persistence.js';
import { useStore } from './store.js';
export function useChatDraft(id:string|null) {
 const target:DraftTarget={kind:'chat',id};const key=draftKey(target);
 const data=useDrafts(s=>s.entries[key]?.data??EMPTY_COMPOSER_DRAFT);
 useEffect(()=>{let active=true;const release=retainDraft(target);void loadDraft(target).then(()=>{
  if(!active||id!==null)return;
  const e=useDrafts.getState().entries[key];
  if(e?.revision)useStore.setState({draftProjectId:e.data.projectId,draftRoleId:e.data.roleId,draftModel:e.data.model,draftThinking:e.data.thinking});
  else {const s=useStore.getState();patchDraft(target,{projectId:s.draftProjectId,roleId:s.draftRoleId,model:s.draftModel,thinking:s.draftThinking});}
 }).catch(()=>{});return()=>{active=false;release();};},[key]);
 const setText=(text:string)=>patchDraft(target,{text});
 const setAttachments=(value:Attachment[]|((a:Attachment[])=>Attachment[]))=>{
  const previous=useDrafts.getState().entries[key]?.data.attachments??[];
  const attachments=typeof value==='function'?value(previous):value;
  patchDraft(target,{attachments:attachments.map(({kind,name,data,mimeType})=>({kind,name,data:data??'',...(mimeType?{mimeType}:{})}))});
 };
 return {text:data.text,attachments:data.attachments,setText,setAttachments,target};
}
