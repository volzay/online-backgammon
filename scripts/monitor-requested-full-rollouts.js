'use strict';
const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const activeConfig=JSON.parse(fs.readFileSync('/tmp/requested-cached-native-config.json'));
if(activeConfig.jobs.length!==2||activeConfig.jobs.some(j=>!Number.isSafeInteger(j.jobId)))throw Error('Invalid operator monitor scope');
const SQL=`begin read only;
set local statement_timeout='30s';
select jsonb_build_object('kind','sourceJobs','jobs',jsonb_agg(jsonb_build_object(
 'room',g.room_code,'jobId',j.id,'status',j.status,'slices',j.progress->'slices',
 'currentDecisionIndex',j.progress->'currentDecisionIndex','currentTerminalOutcomes',j.progress->'currentTerminalOutcomes',
 'checkpointPlies',j.progress#>'{currentRolloutCheckpoint,plies}',
 'finishedReviews',jsonb_array_length(coalesce(j.progress->'finishedReviews','[]'::jsonb)),
 'completeCohorts',(select count(*)from jsonb_array_elements(coalesce(j.progress->'finishedReviews','[]'::jsonb))f where f#>>'{review,rollout,coverage,complete}'='true'),
 'cohorts',(select jsonb_agg(jsonb_build_object('decisionIndex',f->'decisionIndex','coverage',f#>'{review,rollout,coverage}',
   'regret',f#>'{review,rollout,regret}','regretLcb',f#>'{review,rollout,regretLcb}','status',f#>'{review,status}'))
  from jsonb_array_elements(coalesce(j.progress->'finishedReviews','[]'::jsonb))f where f#>>'{review,rollout,coverage,complete}'='true'),
 'lastError',j.last_error,'summary',j.result->'summary')))
from private.long_bot_causal_review_jobs j join public.bot_training_games g on g.id=j.training_game_id where j.id in(2411,2412);
select jsonb_build_object('kind','publishedCurrentPatterns','policy',(select policy_implementation_id from private.long_bot_causal_serving_runtime()),
 'terminalPatterns',(select count(*)from jsonb_array_elements(public.get_long_bot_experience_patterns(null))p where p->>'creditVersion'='9'),
 'modelPatterns',(select count(*)from jsonb_array_elements(public.get_long_bot_experience_patterns(null))p where p->>'creditVersion'='10'));
rollback;`;
const META=`const fs=require('fs'),{execFileSync}=require('child_process');
function read(p){try{return JSON.parse(fs.readFileSync(p))}catch(e){if(e.code==='ENOENT')return null;throw e}}
const dirs=['/var/lib/online-backgammon-lem-terminal-review-20261123','/var/lib/online-backgammon-lem-lesson-confirmation-20261123'];
const lem=dirs.map(dir=>{const protocol=read(dir+'/protocol.json'),summary=read(dir+'/summary.json');
 const rows=(protocol?.cases||[]).map((c,i)=>{const r=read(dir+'/case-'+i+'.json');return{turn:c.turnIndex+1,rootChoices:c.candidates.length,complete:r?.ok===true&&r?.coverage?.complete===true,
  completed:r?.coverage?.completedTerminalOutcomes||0,required:c.candidates.length*(protocol?.limits?.samples||32),regret:r?.regret,regretLcb:r?.regretLcb,
  primaryPairedConfidence:r?.primaryPairedConfidence?{complete:r.primaryPairedConfidence.complete,lowerWinProbabilityGain:r.primaryPairedConfidence.lowerWinProbabilityGain,qualifies:r.primaryPairedConfidence.qualifies,counts:r.primaryPairedConfidence.counts}:null}});
 const journal=dir+'/terminal-journal';let durableEndpointFiles=0,active=[];
 if(fs.existsSync(journal))for(const name of fs.readdirSync(journal)){if(!/^[0-9a-f]{64}$/.test(name))continue;const d=journal+'/'+name;for(const file of fs.readdirSync(d)){if(/^slot-s[0-9]{3}-c[0-9a-f]{64}\\.json$/.test(file))durableEndpointFiles++;if(file.startsWith('checkpoint-s')&&file.endsWith('.json')){const r=read(d+'/'+file);if(r?.payload)active.push({plies:r.payload.plies,sample:r.payload.sampleIndex})}}}
 return{stateDirectory:dir,protocolSha256:protocol?.manifestSha256,preparedAt:protocol?.preparedAt,primaryConfidence:protocol?.primaryConfidence,
 complete:summary?.complete===true,rows,durableEndpointFiles,active};});
const units=['long-bot-requested-cached-2401.service','long-bot-requested-cached-2402.service','long-bot-lem-terminal-review.service','long-bot-lem-lesson-confirmation.service'];
const health=Object.fromEntries(units.map(unit=>[unit,Object.fromEntries(execFileSync('systemctl',['show',unit,'-p','ActiveState','-p','SubState','-p','Result'],{encoding:'utf8'}).trim().split('\\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)]}))]));
console.log(JSON.stringify({kind:'serverFiles',lem,health}));`;
function inspect(){const script="set -euo pipefail\ndocker exec -i supabase-db psql -XqAt -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'\n"+SQL+"\nSQL\nnode <<'JS'\n"+META+"\nJS\n";
 const result=spawnSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','HostKeyAlias=201.51.7.193','-6','root@2a03:6f00:a::ae1e','bash -s'],{input:script,encoding:'utf8',timeout:50000,maxBuffer:8*1024*1024});
 if(result.status!==0)throw Error(result.stderr.trim()||'Remote inspection failed');
 const rows=result.stdout.trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
 const snapshot={checkedAt:new Date().toISOString(),stage:'full-terminal-computation-running',activeNativeReview:activeConfig,cacheEquivalenceTests:{nativeOutcomePairs:32,terminalOutcomesPerCohort:64,completeNativeCohortsCompared:2,winnerVectorsIdentical:true},...Object.fromEntries(rows.map(r=>[r.kind,r]))};
 snapshot.done=snapshot.sourceJobs.jobs.length===2&&snapshot.sourceJobs.jobs.every(j=>j.status==='complete'&&j.completeCohorts===4)
  &&snapshot.serverFiles.lem.length===2&&snapshot.serverFiles.lem.every(r=>r.complete);
 snapshot.failed=Object.entries(snapshot.serverFiles.health).filter(([name,h])=>h.ActiveState==='failed').map(([name,h])=>({name,...h}));
 const file='/tmp/requested-full-rollout-monitor-latest.json';fs.writeFileSync(file+'.next',JSON.stringify(snapshot,null,2)+'\n');fs.renameSync(file+'.next',file);
 const durable='/Users/vlad/Documents/online-backgammon/docs/hard-bot-full-rollouts-progress-2026-11-23.json';fs.writeFileSync(durable+'.next',JSON.stringify(snapshot,null,2)+'\n');fs.renameSync(durable+'.next',durable);
 return snapshot;}
async function monitor(){for(;;){const r=inspect();console.log(JSON.stringify({at:r.checkedAt,done:r.done,failed:r.failed,jobs:r.sourceJobs.jobs.map(j=>({room:j.room,status:j.status,slices:j.slices,decision:j.currentDecisionIndex,outcomes:j.currentTerminalOutcomes,completeCohorts:j.completeCohorts})),lem:r.serverFiles.lem.map(l=>({complete:l.complete,files:l.durableEndpointFiles,cases:l.rows.filter(r=>r.complete).length,totalCases:l.rows.length,active:l.active}))}));if(r.done||r.failed.length)return r;await new Promise(resolve=>setTimeout(resolve,60000));}}
if(require.main===module){fs.writeFileSync('/tmp/requested-full-rollout-monitor.pid',String(process.pid));if(process.argv.includes('--once')){console.log(JSON.stringify(inspect()));}else monitor().catch(e=>{console.error(e.message);process.exitCode=1});}
module.exports={inspect};
