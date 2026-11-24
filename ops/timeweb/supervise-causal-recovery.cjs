'use strict';
// Operator scheduling only: immutable workers retain their own algorithms,
// scientific journals, job bindings and database progress validators.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {ROOTS}=require('./run-causal-job-recovery.cjs');
const {createRecoverySchedule}=require('./recovery-schedule-state.cjs');
async function main(){
 const plan=JSON.parse(fs.readFileSync(process.argv[2]));
 if(!Array.isArray(plan)||plan.length!==43||new Set(plan.map(x=>x.jobId)).size!==43
  ||plan.some(x=>!ROOTS[x.runtime]||!new RegExp('^long-recovery-'+x.jobId+'-[0-9a-f-]{36}$').test(x.worker)))throw Error('Exact 43-job grant plan required');
 // The initial order is fixed; a private durable cursor prevents restarts
 // from repeatedly consuming the service budget on the same prefix.
 plan.sort((a,b)=>b.jobId-a.jobId);
 const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)throw Error('Production endpoint required');
 const journal=process.env.CAUSAL_RECOVERY_JOURNAL||'/var/lib/online-backgammon-causal-worker/terminal-journal';
 const isolated=journal==='/var/lib/online-backgammon-causal-recovery-20261123/terminal-journal';
 if(!isolated&&journal!=='/var/lib/online-backgammon-causal-worker/terminal-journal')throw Error('Fixed private recovery root required');
 const marker=path.join(path.dirname(journal),'campaign.complete'),started=Date.now();
 const schedule=isolated?createRecoverySchedule(plan,path.dirname(journal)):null;
 if(isolated){
  const r=await fetch(url.replace(/\/$/,'')+'/rest/v1/rpc/renew_long_bot_recovery_campaign',{
   method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Connection:'close'},body:'{}',signal:AbortSignal.timeout(15000)});
  if(!r.ok||(await r.json()).renewed!==43)throw Error('Recovery scope renewal failed');
 }
 async function status(x){
  let r;
  // This RPC only reads metadata. Retry bounded transient transport/server
  // failures here; native checkpoint/complete mutations are never replayed.
  for(let attempt=0;attempt<4;attempt++){
   try{r=await fetch(url.replace(/\/$/,'')+'/rest/v1/rpc/get_long_bot_recovery_job',{
   method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Connection:'close'},
   body:JSON.stringify({p_worker:x.worker,p_runtime:x.runtime}),signal:AbortSignal.timeout(15000)});
   if(r.ok||r.status<500&&r.status!==429)break;
   }catch{if(attempt===3)throw Error('Recovery metadata transport unavailable');}
   if(attempt<3)await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
  }
  if(!r.ok)throw Error('Recovery status HTTP '+r.status);
  const s=await r.json();if(s.jobId!==x.jobId||s.runtimeDigest!==x.runtime||s.invalidated||!s.sourceUnchanged)throw Error('Recovery source/grant changed');return s;
 }
 const run=x=>new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/flock',['--exclusive','--conflict-exit-code','75','--wait','30','--no-fork',
   path.join(path.dirname(journal),'worker.flock'),process.execPath,
   path.join(__dirname,'run-causal-job-recovery.cjs'),'--run',x.worker,x.runtime],{stdio:'inherit'});
  child.on('error',reject);child.on('exit',code=>resolve(code));
 });
 for(let round=0;round<100;round++){
  let remaining=0;
  for(let step=0;step<plan.length;step++){
   const x=schedule?schedule.current():plan[step];
   if(isolated&&Date.now()-started>=21600000){console.log(JSON.stringify({yielded:true,reason:'bounded-six-hour-service-slice'}));return;}
   const s=await status(x);
   if(s.status==='complete'){if(schedule)schedule.advance(x.jobId);continue;}
   if(['failed','rejected'].includes(s.status))throw Error('Recovery needs investigation: '+JSON.stringify(s));
   remaining++;const code=await run(x);
   if(code!==0&&code!==75)throw Error('Native recovery worker failed, exit '+code);
   const after=await status(x);console.log(JSON.stringify({round,jobId:x.jobId,status:after.status,slices:after.slices}));
   if(['failed','rejected'].includes(after.status))throw Error('Recovery stopped with '+after.status+' job '+x.jobId);
   if(schedule)schedule.advance(x.jobId);
  }
  if(!remaining){if(isolated)fs.writeFileSync(marker,JSON.stringify({completed:43,at:new Date().toISOString()})+'\n',{mode:0o600});console.log(JSON.stringify({done:true,completed:43}));return;}
 }
 throw Error('Bounded recovery supervision exhausted');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
