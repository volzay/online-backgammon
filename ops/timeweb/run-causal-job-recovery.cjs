'use strict';
// Scheduling/transport only. Every review is calculated and checkpointed by
// its original immutable worker, with its original private authenticated journal.
const {spawn}=require('node:child_process');
const ROOTS=Object.freeze({
 '430a0f4ea942c2282b8529fcf39fe9347194d1124432b3dc8b4d0fad25594a2a':'/opt/online-backgammon-causal-worker.pre-ac943a4-20260919T0630Z',
 '3851848f4dae179c2f8ad6a1d1e8f66c39a1300b7b1dcb671d46b3c564dbaff7':'/opt/online-backgammon-causal-worker.previous-20260926T210404Z',
 '434af2595488a4265243951ce7918cab420e647c3c190a492b0428c382f52162':'/opt/online-backgammon-causal-worker.previous-07c0796',
 'b0da4db3a3f62c63cc4450eab1bc31e80a17e8215950fc596e9e3b6fff2a9ecb':'/opt/online-backgammon-causal-worker.prev-e405a96',
 'e1d4fe1bfc0fd04dbbad797ef2f4c7eb05509d0923d9d8449f9d313941d6e967':'/opt/online-backgammon-causal-worker.prev-20261018-e405a96',
});
const URL=process.env.CAUSAL_RECOVERY_URL||process.env.SUPABASE_URL;
async function main(){
 // Do not reuse an idle HTTP socket after a long synchronous native slice.
 const nativeFetch=globalThis.fetch;
 globalThis.fetch=(url,options={})=>{const headers=new Headers(options.headers);headers.set('Connection','close');return nativeFetch(url,{...options,headers});};
 const [mode,worker,runtime]=process.argv.slice(2),root=ROOTS[runtime];
 if(!root||!/^long-recovery-[0-9]+-[0-9a-f-]{36}$/.test(worker)||!['--run','--heartbeat'].includes(mode))throw Error('Fixed recovery scope required');
 const w=require(root+'/scripts/long-bot-causal-worker');
 if(w.runtimeDigest()!==runtime)throw Error('Original immutable runtime differs');
 if(!URL)throw Error('Configured production RPC endpoint required');
 const rpc=(name,args)=>w.supabaseRpc(URL,process.env.SUPABASE_SERVICE_ROLE_KEY,name,args);
 if(mode==='--heartbeat'){
  const parent=Number(process.env.RECOVERY_PARENT_PID);if(!Number.isSafeInteger(parent)||parent<2)throw Error('Supervisor PID required');
  for(;;){try{process.kill(parent,0);}catch{return;}
   await rpc('heartbeat_long_bot_recovery_job',{p_worker:worker,p_runtime:runtime});
   await new Promise(r=>setTimeout(r,10000));
  }
 }
 const heartbeat=spawn(process.execPath,[__filename,'--heartbeat',worker,runtime],{env:{...process.env,RECOVERY_PARENT_PID:String(process.pid)},stdio:['ignore','inherit','inherit']});
 try{
  const start=Date.now();
  while(Date.now()-start<600000){
   const before=await rpc('get_long_bot_recovery_job',{p_worker:worker,p_runtime:runtime});
   if(!before||before.runtimeDigest!==runtime||before.invalidated||!before.sourceUnchanged)throw Error('Recovery source or grant changed');
   if(['complete','rejected'].includes(before.status)){console.log(JSON.stringify({done:true,...before}));return;}
   if(before.status==='failed')throw Error('Bounded recovery stopped: '+JSON.stringify(before));
   const r=await w.runClaimedBatch({workerId:worker,supabaseUrl:URL,
    productionJournalDirectory:process.env.CAUSAL_RECOVERY_JOURNAL||'/var/lib/online-backgammon-causal-worker/terminal-journal',limit:1});
   if(!r||r.claimed>1||!Array.isArray(r.completed))throw Error('Invalid native recovery receipt');
   if(r.completed.some(x=>x.jobId&&x.jobId!==before.jobId))throw Error('Native recovery left its original job');
   const after=await rpc('get_long_bot_recovery_job',{p_worker:worker,p_runtime:runtime});
   console.log(JSON.stringify({at:new Date().toISOString(),...after}));
   if(r.claimed===0)await new Promise(resolve=>setTimeout(resolve,5000));
  }
 }finally{heartbeat.kill();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={ROOTS};
