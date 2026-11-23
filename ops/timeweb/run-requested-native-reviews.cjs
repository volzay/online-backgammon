'use strict';
// Scheduling only; every result is produced by the original immutable native
// worker, under its actual Linux flock, original archive and signed journal.
const fs=require('node:fs');
const APP='/opt/online-backgammon-hard-quarters-d33a1c62';
const RUNTIME='d7fd1192b3c1cea8e1793b9261703f85c4a9effd18169dc2eeb1b4a567b99183';
async function run({workerId,jobId,stateDirectory}){
 const w=require(APP+'/scripts/long-bot-causal-worker');
 if(w.runtimeDigest()!==RUNTIME)throw Error('Original reviewer runtime mismatch');
 const status=()=>w.supabaseRpc(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,
  'get_requested_long_bot_review_status',{p_worker_id:workerId,p_runtime_digest:RUNTIME});
 while(!fs.existsSync(stateDirectory+'/pause-admission')){
  const before=await status();
  if(!before||before.jobId!==jobId||before.invalidated)throw Error('Requested scope or source changed');
  if(before.status==='complete'){console.log(JSON.stringify({done:true,...before}));return;}
  if(['failed','rejected'].includes(before.status))throw Error('Native job stopped: '+JSON.stringify(before));
  const r=await w.runClaimedBatch({workerId,productionJournalDirectory:stateDirectory+'/terminal-journal',limit:1});
  if(r.lifecycle!=='long-server-resumable-slices-v2'||!Array.isArray(r.completed)
   ||r.completed.some(c=>c.jobId!==jobId||c.accepted===false))throw Error('Native requested slice failed: '+JSON.stringify(r));
  console.log(JSON.stringify({at:new Date().toISOString(),...await status()}));
  if(r.claimed===0)await new Promise(resolve=>setTimeout(resolve,5000));
 }
}
if(require.main===module){const [workerId,id,stateDirectory]=process.argv.slice(2);const jobId=Number(id);
 if(!/^long-requested-[0-9a-f-]{36}$/.test(workerId)||![2401,2402].includes(jobId)
  ||stateDirectory!==`/var/lib/online-backgammon-requested-native-${jobId}`)throw Error('Invalid fixed scope');
 run({workerId,jobId,stateDirectory}).catch(e=>{console.error(e.message);process.exitCode=1});}
module.exports={run};
