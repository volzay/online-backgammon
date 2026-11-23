'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const BASE='/opt/online-backgammon-expanded-compute-v1';
const ROOTS={
 '18f05bafa638c1d0dea35c5bfa933c071a1bfa409bd55333e30871c5bc961ec5':'/opt/online-backgammon-hard-quarters-cached-v1',
 '0eab9068781ca4967ef362224ff7cfcff2200447fbbec7527ee39296a55f92b6':'/opt/online-backgammon-live-transfer-7a263bcd-r2',
};
const [id,partText,startText]=process.argv.slice(2),part=Number(partText),start=Number(startText);
if(!/^(?:8JPN-KUD8-d(?:1|7|19|33)|CTNM-E43Z-d(?:1|5|9|13)|LEM5-RES8-t(?:3|6|11|12|13|17|18))$/.test(id)
 ||![0,1,2,3].includes(part)||!Number.isSafeInteger(start)||start<0||start>992||start%32)throw Error('Invalid fixed fragment');
const bytes=fs.readFileSync(BASE+'/workloads/'+id+'.json'),input=JSON.parse(bytes),lock=JSON.parse(fs.readFileSync(BASE+'/input-lock.json'));
if(sha(bytes)!==lock.workloads[id]?.sha256||input.id!==id||input.sampleCount!==1024||input.seedOffset<32
 ||input.node!==process.versions.node||input.v8!==process.versions.v8||process.getuid()===0)throw Error('Workload/runtime binding differs');
const root=ROOTS[input.runtimeDigest];if(!root)throw Error('Unapproved native kernel');
const W=require(root+'/scripts/long-bot-causal-worker'),H=require(root+'/scripts/generate-long-bot-shadow-replay'),Q=require(root+'/scripts/long-bot-paired-rollout');
const runtime=H.loadRuntime(),{game,engine}=runtime;
if(W.runtimeDigest()!==input.runtimeDigest||W.policyImplementationId()!==input.policyImplementationId
 ||runtime.gameBytesDigest!==input.gameBytesDigest||runtime.runtimeBytesDigest!==input.runtimeBytesDigest)throw Error('Native closure drift');
for(const [,file]of W.runtimeClosureFiles()){
 const s=fs.lstatSync(file);if(!s.isFile()||s.uid!==0||(s.mode&0o022)||s.nlink!==1||fs.realpathSync(file)!==file)throw Error('Mutable native closure');
}
const possible=new Set(game.bestMoveSequences(input.state,input.state.turn).map(m=>sha(H.afterPositionKey(H.applyLegalSequence(game,input.state,m)))));
if(input.candidates.some(c=>c.candidateId!==sha(H.afterPositionKey(c.afterState))||!possible.has(c.candidateId))
 ||input.legalScope==='complete-original-legal-root-set'&&possible.size!==input.candidates.length
 ||!input.candidates.some(c=>c.candidateId===input.controlId))throw Error('Native legal-root/control mismatch');
engine.setExperience([],'server-causal-rollout');
const state='/var/lib/online-backgammon-expanded-'+id+'-'+start+'-'+part;
const fence=require(root+'/scripts/long-bot-production-fence').assertProductionFence({journalDirectory:state+'/terminal-journal',applicationDirectory:root});
const cache=Q.createNativeColdCohortCache(runtime,input.limits,{runtimeDigest:input.runtimeDigest,policyImplementationId:input.policyImplementationId,gameBytesDigest:runtime.gameBytesDigest,runtimeBytesDigest:runtime.runtimeBytesDigest});
if(!cache.enabled())throw Error('Audited native cache refused closure');
const seeds=input.seedsBySample.slice(start,start+32);
// Native journal format remains unchanged: each authenticated 32-slot journal
// is an explicitly identified fragment of the larger prespecified experiment.
const journal=require(root+'/scripts/long-bot-terminal-journal').createTerminalJournal({directory:state+'/terminal-journal',manifest:{
 schema:'long-bot-terminal-cohort-manifest-v1',sampleCount:32,candidateIds:input.candidates.map(c=>c.candidateId),seedsBySample:seeds,
 botColor:input.botColor,maxPlies:input.limits.maxPlies,bindings:{schema:'long-expanded-study-native-fragment-v1',inputSha256:sha(bytes),start,end:start+32}}});
const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
emit({type:'identity',id,part,start,end:start+32,uid:process.getuid(),node:process.versions.node,v8:process.versions.v8,
 inputSha256:sha(bytes),executorSha256:sha(fs.readFileSync(__filename)),runtimeDigest:W.runtimeDigest(),policyImplementationId:W.policyImplementationId(),linuxFence:fence.assertHeld()});
for(let local=part;local<32;local+=4)for(const candidate of input.candidates){
 fence.assertHeld();let saved=journal.lookup(local,candidate.candidateId,seeds[local]);
 if(!saved){let outcome;for(;;){outcome=Q.playTerminalRollout(runtime,candidate.afterState,input.botColor,seeds[local],input.limits,Date.now(),{
  nativeCache:cache,nativeHistoryProjection:true,resumeCheckpoint:journal.lookupCheckpoint(local,candidate.candidateId,seeds[local]),
  saveCheckpoint:next=>{journal.saveCheckpoint({sampleIndex:local,candidateId:candidate.candidateId,seeds:seeds[local],...next});emit({type:'progress',id,start,part,sample:start+local,plies:next.plies});}});
  if(outcome.complete)break;if(outcome.reason!=='rollout-time-limit')throw Error('Censored native outcome: '+outcome.reason);
 }
 saved={sampleIndex:local,candidateId:candidate.candidateId,seeds:seeds[local],winner:outcome.winner,plies:outcome.plies,complete:true};journal.commit(saved);}
 const {manifestId,...record}=saved;emit({type:'outcome',...record,sampleIndex:start+local,localSampleIndex:local});
}
journal.close();emit({type:'complete',id,part,start,end:start+32,linuxFence:fence.assertHeld(),cache:cache.observation()});
