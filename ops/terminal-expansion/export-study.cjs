'use strict';
// Operator-only preparation. Publishes the same 15 previously authorised
// anonymous board datasets; original archives and journal keys stay private.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const BASE='/var/lib/online-backgammon-requested-compute-plan-20261123';
const OUTPUT='/var/lib/online-backgammon-expanded-study-20261123';
const ROOTS={
 '18f05bafa638c1d0dea35c5bfa933c071a1bfa409bd55333e30871c5bc961ec5':'/opt/online-backgammon-hard-quarters-cached-v1',
 '0eab9068781ca4967ef362224ff7cfcff2200447fbbec7527ee39296a55f92b6':'/opt/online-backgammon-live-transfer-7a263bcd-r2',
};
const STAGES=[128,512,1024];
function safeState(s){
 const keys=['variant','phase','turn','winner','resultType','points','off','bar','dice','rolled','firstMoveDone','headPlayedThisTurn','turnMoves'];
 return {...Object.fromEntries(keys.filter(k=>s[k]!==undefined).map(k=>[k,structuredClone(s[k])])),history:[]};
}
function main(){
 if(process.platform!=='linux'||process.getuid()!==0)throw Error('Private Linux operator required');
 if(fs.existsSync(OUTPUT))throw Error('Never overwrite a prespecified study');
 const plans=JSON.parse(fs.readFileSync(BASE+'/private-import-plan.json')).plans;if(plans.length!==15)throw Error('Expected original 15 strategic cases');
 fs.mkdirSync(OUTPUT,{mode:0o700});fs.mkdirSync(OUTPUT+'/workloads',{mode:0o700});
 const cases=[];
 for(const p of plans){
  const originalBytes=fs.readFileSync(BASE+'/public/'+p.id+'.json'),old=JSON.parse(originalBytes);
  if(sha(originalBytes)!==p.workloadSha256||!ROOTS[old.runtimeDigest])throw Error('Original source changed');
  const root=ROOTS[old.runtimeDigest],w=require(root+'/scripts/long-bot-causal-worker');
  const H=require(root+'/scripts/generate-long-bot-shadow-replay'),Q=require(root+'/scripts/long-bot-paired-rollout');
  if(w.runtimeDigest()!==old.runtimeDigest||w.policyImplementationId()!==old.policyImplementationId)throw Error('Frozen native identity changed');
  const originalState=JSON.parse(p.manifest.bindings.orderedStateCanonical),state=safeState(originalState);
  if(Q.canonicalNativeState(originalState)!==Q.canonicalNativeState(state))throw Error('Anonymous projection changed native rules state');
  const stateId=sha('nardu/long-causal-rollout/state/v1\0'+H.stableStringify(originalState));
  for(let i=0;i<32;i++)if(H.stableStringify(Q.derivePairedSeeds(stateId,i))!==H.stableStringify(old.seedsBySample[i]))throw Error('Original seed identity differs');
  let offset=4096,seeds;
  for(;;){seeds=Array.from({length:1024},(_,i)=>Q.derivePairedSeeds(stateId,offset+i));
   const all=[...old.seedsBySample,...seeds].flatMap(s=>[s.white,s.dark]);
   if(new Set(all).size===all.length)break;offset+=4096;if(offset>65536)throw Error('No collision-free prespecified seed block');
  }
  const controlId=sha(p.manifest.bindings.selectedAfterPositionKey);
  if(!old.candidates.some(c=>c.candidateId===controlId))throw Error('Original control missing');
  const input={...old,schema:'long-expanded-native-study-input-v1',originalInputSha256:sha(originalBytes),
   originalManifestId:old.manifestId,sampleCount:1024,stages:STAGES,seedOffset:offset,seedsBySample:seeds,
   state,controlId,sourceRoom:p.id.split(/-[dt]/)[0],
   legalScope:p.id.startsWith('LEM5-')?'two-prespecified-model-actions':'complete-original-legal-root-set'};
  // The old manifest is retained as provenance only; no new endpoint is
  // written into or counted as one of its original 32 slots.
  delete input.manifestId;
  const bytes=JSON.stringify(input,null,2)+'\n';fs.writeFileSync(OUTPUT+'/workloads/'+p.id+'.json',bytes,{mode:0o600,flag:'wx'});
  cases.push({id:p.id,inputSha256:sha(bytes),runtimeDigest:old.runtimeDigest,policyImplementationId:old.policyImplementationId,
   controlId,candidates:old.candidates.length,originalManifestId:old.manifestId,seedOffset:offset});
 }
 const comparisons=cases.reduce((n,c)=>n+c.candidates-1,0);
 const protocol={schema:'long-expanded-fixed-look-terminal-study-v1',preparedAt:new Date().toISOString(),
  originalInputs:15,newIndependentSamplesOnly:true,stages:STAGES,maxPairsPerCase:1024,
  familywiseAlpha:0.05,minEffectLowerBound:0.08,comparisons,
  positiveCaseAlpha:0.05/(2*cases.length*STAGES.length),pairedComparisonAlpha:0.05/(2*comparisons*STAGES.length),
  positiveRule:'original-simultaneous-Hoeffding-and-paired-CP-lower-bounds-both-above-0.08',
  futilityRule:'every-prespecified-alternative-paired-CP-upper-bound-at-most-0.08',
  noWithinLookOptionalStopping:true,noExtensionAfterFinalLook:true,
  originalPoliciesRetained:true,terminalProofsNeverAliasedToCurrentPolicy:true,cases};
 protocol.protocolSha256=sha(JSON.stringify(protocol));
 fs.writeFileSync(OUTPUT+'/protocol.json',JSON.stringify(protocol,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({prepared:true,cases:cases.length,comparisons,stages:STAGES,maxEndpoints:cases.reduce((n,c)=>n+1024*c.candidates,0),protocolSha256:protocol.protocolSha256}));
}
if(require.main===module)main();
module.exports={safeState,STAGES};
