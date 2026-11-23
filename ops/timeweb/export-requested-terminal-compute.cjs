'use strict';
// Run only on the operator's Linux host. The private import plan stays there;
// the public workload contains board/rules state and deterministic seeds only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const OUTPUT='/var/lib/online-backgammon-requested-compute-plan-20261123';
const CACHED='/opt/online-backgammon-hard-quarters-cached-v1';
const CURRENT='/opt/online-backgammon-live-transfer-7a263bcd-r2';
function manifests(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
 const file=path.join(dir,e.name);return e.isDirectory()?manifests(file):e.name==='manifest.json'?[{file,manifest:JSON.parse(fs.readFileSync(file))}]:[];});}
function write(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});}
function publicState(state,paired){
 const keys=['variant','phase','turn','winner','resultType','points','off','bar','dice','rolled','firstMoveDone','headPlayedThisTurn','turnMoves'];
 const safe=Object.fromEntries(keys.map(k=>[k,structuredClone(state[k])]));safe.history=[];
 if(paired.canonicalNativeState(safe)!==paired.canonicalNativeState(state)||!paired.canonicalNativeState(safe))throw Error('Board projection changed native state');
 return safe;
}
async function main(){
 fs.mkdirSync(OUTPUT,{mode:0o700});const plans=[],workloads=[];
 function append(id,root,stateDirectory,journalDirectory,manifest,decision,candidates){
  const paired=require(root+'/scripts/long-bot-paired-rollout'),shadow=require(root+'/scripts/generate-long-bot-shadow-replay');
  const w=require(root+'/scripts/long-bot-causal-worker'),runtime=shadow.loadRuntime();
  const preimage=require(root+'/scripts/long-bot-terminal-journal').canonicalManifest(manifest),manifestId=sha(preimage);
  const ordered=[...candidates].sort((a,b)=>shadow.afterPositionKey(a).localeCompare(shadow.afterPositionKey(b)));
  const inputs=ordered.map(c=>({candidateId:sha(shadow.afterPositionKey(c)),afterState:publicState(paired.applyCompleteAction(runtime,decision,c),paired)}));
  if(JSON.stringify(inputs.map(c=>c.candidateId))!==JSON.stringify(manifest.candidateIds))throw Error('Candidate order differs');
  const workload={schema:'long-requested-native-terminal-compute-v1',id,manifestId,
   runtimeDigest:w.runtimeDigest(),policyImplementationId:w.policyImplementationId(),
   gameBytesDigest:runtime.gameBytesDigest,runtimeBytesDigest:runtime.runtimeBytesDigest,
   node:process.versions.node,v8:process.versions.v8,botColor:manifest.botColor,
   seedsBySample:manifest.seedsBySample,limits:manifest.bindings.rolloutLimits,candidates:inputs};
  const serialized=JSON.stringify(workload,null,2)+'\n';workloads.push({id,workload});
  plans.push({id,root,stateDirectory,journalDirectory,manifest,manifestId,workloadSha256:sha(serialized)});
 }
 for(const source of JSON.parse(fs.readFileSync('/opt/online-backgammon-requested-native-dispatch-v2/config.json')).jobs){
  const sql=`begin read only;set local statement_timeout='20s';select jsonb_build_object('jobId',j.id,'runtimeDigest',j.runtime_digest,'policyImplementationId',r.policy_implementation_id,'archiveFingerprint',j.archive_fingerprint,'archiveFingerprintSource',private.long_bot_causal_archive_payload(g)::text,'trainingGame',private.long_bot_causal_archive_payload(g))from private.long_bot_causal_review_jobs j join public.bot_training_games g on g.id=j.training_game_id join private.long_bot_causal_releases r on r.runtime_digest=j.runtime_digest where j.id=${source.jobId};rollback;`;
  const raw=execFileSync('docker',['exec','-i','supabase-db','psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{input:sql,encoding:'utf8',maxBuffer:32*1024*1024});
  const w=require(CACHED+'/scripts/long-bot-causal-worker'),shadow=require(CACHED+'/scripts/generate-long-bot-shadow-replay'),paired=require(CACHED+'/scripts/long-bot-paired-rollout');
  const [job]=w.validateClaimedJobs([JSON.parse(raw.trim())],w.runtimeDigest(),w.policyImplementationId());
  if(w.validateGameEnvelope(job.game))throw Error('Invalid original archive');
  const current=manifests(source.stateDirectory+'/terminal-journal');if(current.length!==1)throw Error('Expected one admitted current cohort');
  const base=current[0].manifest,journalDirectory=path.dirname(path.dirname(current[0].file));
  const plan=w.productionStrategicReviewPlan(job.game),expected=source.room==='8JPN-KUD8'?[7,1,33,19]:[5,1,9,13];
  if(JSON.stringify(plan.expensiveDecisionIndexes)!==JSON.stringify(expected))throw Error('Original curriculum changed');
  for(const index of expected){
   const d=w.trainingDecisions(job.game)[index];
   if(d.experienceSize!==0)throw Error('Unexpected warm source');
   const replay=await shadow.generateLongBotShadowReplay(job.game,d,{limits:w.DEFAULT_LIMITS});
   if(!replay.ok||!replay.replay.coverage.complete)throw Error('Incomplete original legal replay: '+replay.reason);
   const regenerated=w.regenerateArchivedSelection(job.game,d);if(!regenerated.ok)throw Error(regenerated.reason);
   const candidates=[...replay.replay.candidates].sort((a,b)=>shadow.afterPositionKey(a).localeCompare(shadow.afterPositionKey(b)));
   const ids=candidates.map(c=>sha(shadow.afterPositionKey(c)));
   const stateId=sha('nardu/long-causal-rollout/state/v1\0'+shadow.stableStringify(d.stateSnapshotV2));
   const m={...base,candidateIds:ids,seedsBySample:Array.from({length:32},(_,i)=>paired.derivePairedSeeds(stateId,i)),botColor:d.color||d.stateSnapshotV2.turn,
    bindings:{...base.bindings,sourceDecisionIndex:index,sourceDecisionId:d.id,
     orderedOriginalExecutionCanonical:shadow.stableStringify(d.execution),regeneratedSelectedContextKey:regenerated.selected.experience.contextKey,
     regeneratedSelectedActionKey:regenerated.selected.experience.actionKey,originalSelectionPolicy:w.serverOwnedDecisionPolicy(d),
     orderedStateCanonical:shadow.stableStringify(d.stateSnapshotV2),selectedOrderedMoveKey:shadow.canonicalMoveKey(d.selected.moves),
     selectedAfterPositionKey:shadow.afterPositionKey(d.selected),completeOrderedLegalSet:candidates.map((c,i)=>({candidateId:ids[i],afterPositionKey:shadow.afterPositionKey(c),orderedMoveKey:shadow.canonicalMoveKey(c.moves)}))}};
   if(index===base.bindings.sourceDecisionIndex&&shadow.stableStringify(m)!==shadow.stableStringify(base))throw Error('Reconstructed current manifest differs from native admission');
   append(source.room+'-d'+index,CACHED,source.stateDirectory,journalDirectory,m,d,candidates);
  }
 }
 const state='/var/lib/online-backgammon-lem-lesson-confirmation-20261123',protocol=JSON.parse(fs.readFileSync(state+'/protocol.json'));
 const original=manifests(state+'/terminal-journal');if(original.length!==7)throw Error('Expected all seven prespecified LEM cohorts');
 for(const [index,c]of protocol.cases.entries()){
  const m=original.find(x=>x.manifest.bindings.caseIndex===index)?.manifest;
  if(!m||m.bindings.protocolSha256!==protocol.manifestSha256)throw Error('LEM protocol mismatch');
  append('LEM5-RES8-t'+(c.turnIndex+1),CURRENT,state,state+'/terminal-journal',m,c.decision,c.candidates);
 }
 write(OUTPUT+'/private-import-plan.json',{schema:'long-requested-native-private-import-plan-v1',preparedAt:new Date().toISOString(),plans});
 fs.mkdirSync(OUTPUT+'/public',{mode:0o700});for(const x of workloads)write(OUTPUT+'/public/'+x.id+'.json',x.workload);
 console.log(JSON.stringify({prepared:true,workloads:workloads.length,terminalEndpoints:workloads.reduce((n,x)=>n+x.workload.candidates.length*32,0)}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
