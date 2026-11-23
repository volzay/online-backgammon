'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const BASE='/opt/online-backgammon-requested-compute-v1';
const ROOTS={
 '18f05bafa638c1d0dea35c5bfa933c071a1bfa409bd55333e30871c5bc961ec5':'/opt/online-backgammon-hard-quarters-cached-v1',
 '0eab9068781ca4967ef362224ff7cfcff2200447fbbec7527ee39296a55f92b6':'/opt/online-backgammon-live-transfer-7a263bcd-r2',
};
const id=process.argv[2],part=Number(process.argv[3]);
const sampleStart=Number(process.argv[4]??0),sampleEnd=Number(process.argv[5]??32);
if(!Number.isSafeInteger(sampleStart)||!Number.isSafeInteger(sampleEnd)||sampleStart<0||sampleEnd>32||sampleStart%8||sampleEnd<=sampleStart
 ||!((sampleStart===0&&sampleEnd===32)||sampleEnd===sampleStart+8))throw Error('Fixed original sample range required');
if(!/^(?:8JPN-KUD8-d(?:1|7|19|33)|CTNM-E43Z-d(?:1|5|9|13)|LEM5-RES8-t(?:3|6|11|12|13|17|18))$/.test(id)||![0,1,2,3].includes(part))throw Error('Unknown fixed workload');
const bytes=fs.readFileSync(BASE+'/workloads/'+id+'.json'),input=JSON.parse(bytes),lock=JSON.parse(fs.readFileSync(BASE+'/input-lock.json'));
if(sha(bytes)!==lock.workloads[id]?.sha256||input.id!==id||input.node!==process.versions.node||input.v8!==process.versions.v8||process.getuid()===0)throw Error('Workload or runtime mismatch');
const root=ROOTS[input.runtimeDigest];if(!root)throw Error('Unapproved runtime');
const w=require(root+'/scripts/long-bot-causal-worker'),shadow=require(root+'/scripts/generate-long-bot-shadow-replay');
const paired=require(root+'/scripts/long-bot-paired-rollout');
const state='/var/lib/online-backgammon-requested-compute-'+id+'-'+part;
const fence=require(root+'/scripts/long-bot-production-fence').assertProductionFence({journalDirectory:state+'/terminal-journal',applicationDirectory:root});
for(const [,file]of w.runtimeClosureFiles()){
 const s=fs.lstatSync(file);if(!s.isFile()||s.uid!==0||(s.mode&0o022)||s.nlink!==1||fs.realpathSync(file)!==file)throw Error('Mutable native closure');
}
const runtime=shadow.loadRuntime();
if(w.runtimeDigest()!==input.runtimeDigest||w.policyImplementationId()!==input.policyImplementationId||runtime.gameBytesDigest!==input.gameBytesDigest||runtime.runtimeBytesDigest!==input.runtimeBytesDigest)throw Error('Native source identity differs');
runtime.engine.setExperience([],'server-causal-rollout');
const cache=paired.createNativeColdCohortCache(runtime,input.limits,{runtimeDigest:input.runtimeDigest,policyImplementationId:input.policyImplementationId,gameBytesDigest:runtime.gameBytesDigest,runtimeBytesDigest:runtime.runtimeBytesDigest});
if(!cache.enabled())throw Error('Native cold cache guard refused actual runtime');
const journal=require(root+'/scripts/long-bot-terminal-journal').createTerminalJournal({directory:state+'/terminal-journal',manifest:{
 schema:'long-bot-terminal-cohort-manifest-v1',sampleCount:32,candidateIds:input.candidates.map(c=>c.candidateId),seedsBySample:input.seedsBySample,
 botColor:input.botColor,maxPlies:input.limits.maxPlies,bindings:{schema:'long-attested-compute-local-journal-v1',originalManifestId:input.manifestId,inputSha256:sha(bytes)}}});
const emit=message=>process.stdout.write(JSON.stringify(message)+'\n');
emit({type:'identity',id,part,sampleStart,sampleEnd,workloadSha256:sha(bytes),executorSha256:sha(fs.readFileSync(__filename)),runtimeDigest:w.runtimeDigest(),policyImplementationId:w.policyImplementationId(),node:process.versions.node,v8:process.versions.v8,linuxFence:fence.assertHeld(),uid:process.getuid()});
for(let sample=sampleStart+part;sample<sampleEnd;sample+=4)for(const candidate of input.candidates){
 fence.assertHeld();const saved=journal.lookup(sample,candidate.candidateId,input.seedsBySample[sample]);
 if(saved){const {manifestId,...record}=saved;emit({type:'outcome',...record});continue;}
 let outcome;
 for(;;){
  outcome=paired.playTerminalRollout(runtime,candidate.afterState,input.botColor,input.seedsBySample[sample],input.limits,Date.now(),{
   nativeCache:cache,nativeHistoryProjection:true,resumeCheckpoint:journal.lookupCheckpoint(sample,candidate.candidateId,input.seedsBySample[sample]),
   saveCheckpoint:next=>{journal.saveCheckpoint({sampleIndex:sample,candidateId:candidate.candidateId,seeds:input.seedsBySample[sample],...next});emit({type:'progress',id,part,sample,candidateId:candidate.candidateId,plies:next.plies});}});
  if(outcome.complete)break;if(outcome.reason!=='rollout-time-limit')throw Error('Native terminal failure: '+outcome.reason);
 }
 if(!['white','dark'].includes(outcome.winner)||!Number.isSafeInteger(outcome.plies)||outcome.plies<0||outcome.plies>input.limits.maxPlies)throw Error('Invalid native endpoint');
 const record={sampleIndex:sample,candidateId:candidate.candidateId,seeds:input.seedsBySample[sample],winner:outcome.winner,plies:outcome.plies,complete:true};
 journal.commit(record);emit({type:'outcome',...record});
}
journal.close();
emit({type:'complete',id,part,cache:cache.observation(),linuxFence:fence.assertHeld()});
