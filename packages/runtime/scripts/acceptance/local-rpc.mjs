import {readFileSync} from 'node:fs';
export async function rpc(name,input={}) {
 const control=JSON.parse(readFileSync(process.env.PIH_ACCEPTANCE_CONTROL??'/tmp/pih-deepseek-live-control.json','utf8'));
 const response=await fetch(`http://127.0.0.1:${control.port}`,{method:'POST',headers:{authorization:`Bearer ${control.token}`,'content-type':'application/json'},body:JSON.stringify({name,input}),signal:AbortSignal.timeout(120000)});
 const value=await response.json();if(!value.ok)throw Error(value.error);return value.result;
}
