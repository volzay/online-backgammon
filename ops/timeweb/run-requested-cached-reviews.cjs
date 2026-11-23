'use strict';
const fs=require('node:fs'),path=require('node:path');
const APP='/opt/online-backgammon-hard-quarters-cached-v1';
const RUNTIME='18f05bafa638c1d0dea35c5bfa933c071a1bfa409bd55333e30871c5bc961ec5';
const POLICY='d33a1c6219a986aee5e64312d233fa38db5aeb86e84aa13e6cd3578918d38306';
async function run(originalJobId){
 if(![2401,2402].includes(originalJobId))throw Error('Unknown source');
 const file=path.join(__dirname,'config.json'),stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.uid!==0||(stat.mode&0o022)||stat.nlink!==1)throw Error('Untrusted operator config');
 const config=JSON.parse(fs.readFileSync(file));const target=config.jobs.find(j=>j.originalJobId===originalJobId);
 if(config.runtime!==RUNTIME||!target||!Number.isSafeInteger(target.jobId)||target.stateDirectory!==`/var/lib/online-backgammon-requested-cached-${originalJobId}`)throw Error('Wrong fixed source scope');
 const w=require(APP+'/scripts/long-bot-causal-worker');
 if(w.runtimeDigest()!==RUNTIME||w.policyImplementationId()!==POLICY)throw Error('Native producer changed');
 const status=()=>w.supabaseRpc(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,
  'get_requested_long_bot_review_status',{p_worker_id:target.workerId,p_runtime_digest:RUNTIME});
 while(!fs.existsSync(target.stateDirectory+'/pause-admission')){
  const before=await status();if(!before||before.jobId!==target.jobId||before.invalidated)throw Error('Source scope changed');
  if(before.status==='complete'){console.log(JSON.stringify({done:true,...before}));return;}
  if(['failed','rejected'].includes(before.status))throw Error('Native job failed: '+JSON.stringify(before));
  const result=await w.runClaimedBatch({workerId:target.workerId,productionJournalDirectory:target.stateDirectory+'/terminal-journal',limit:1});
  if(result.lifecycle!=='long-server-resumable-slices-v2'||!Array.isArray(result.completed)
   ||result.completed.some(row=>row.jobId!==target.jobId||row.accepted===false))throw Error('Native slice rejected: '+JSON.stringify(result));
  console.log(JSON.stringify({at:new Date().toISOString(),originalJobId,...await status()}));
  if(!result.claimed)await new Promise(resolve=>setTimeout(resolve,5000));
 }
}
if(require.main===module)run(Number(process.argv[2])).catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={run};
