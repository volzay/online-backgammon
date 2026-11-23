'use strict';
// Operator scheduling only: immutable workers retain their own algorithms,
// scientific journals, job bindings and database progress validators.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {ROOTS}=require('./run-causal-job-recovery.cjs');
async function main(){
 const plan=JSON.parse(fs.readFileSync(process.argv[2]));
 if(!Array.isArray(plan)||plan.length!==43||new Set(plan.map(x=>x.jobId)).size!==43
  ||plan.some(x=>!ROOTS[x.runtime]||!new RegExp('^long-recovery-'+x.jobId+'-[0-9a-f-]{36}$').test(x.worker)))throw Error('Exact 43-job grant plan required');
 // Finish more recent compatible checkpoints before the oldest v1 cohorts.
 plan.sort((a,b)=>b.jobId-a.jobId);
 const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)throw Error('Production endpoint required');
 async function status(x){
  const r=await fetch(url.replace(/\/$/,'')+'/rest/v1/rpc/get_long_bot_recovery_job',{
   method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Connection:'close'},
   body:JSON.stringify({p_worker:x.worker,p_runtime:x.runtime})});
  if(!r.ok)throw Error('Recovery status HTTP '+r.status);
  const s=await r.json();if(s.jobId!==x.jobId||s.runtimeDigest!==x.runtime||s.invalidated||!s.sourceUnchanged)throw Error('Recovery source/grant changed');return s;
 }
 const run=x=>new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/flock',['--exclusive','--wait','30','--no-fork',
   '/var/lib/online-backgammon-causal-worker/worker.flock',process.execPath,
   path.join(__dirname,'run-causal-job-recovery.cjs'),'--run',x.worker,x.runtime],{stdio:'inherit'});
  child.on('error',reject);child.on('exit',code=>resolve(code));
 });
 for(let round=0;round<100;round++){
  let remaining=0;
  for(const x of plan){const s=await status(x);
   if(s.status==='complete')continue;
   if(['failed','rejected'].includes(s.status))throw Error('Recovery needs investigation: '+JSON.stringify(s));
   remaining++;const code=await run(x);
   if(code!==0&&code!==1)throw Error('Recovery supervisor child exit '+code);
   const after=await status(x);console.log(JSON.stringify({round,jobId:x.jobId,status:after.status,slices:after.slices}));
   if(['failed','rejected'].includes(after.status))throw Error('Recovery stopped with '+after.status+' job '+x.jobId);
  }
  if(!remaining){console.log(JSON.stringify({done:true,completed:43}));return;}
 }
 throw Error('Bounded recovery supervision exhausted');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
