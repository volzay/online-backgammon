'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function validate(result,input,expected){
 const reject=message=>{throw Error(message);};
 if(result.schema!=='long-requested-attested-native-endpoints-v1'||result.complete!==true||result.error
  ||result.id!==input.id||result.inputSha256!==expected.inputSha256||result.manifestId!==input.manifestId
  ||result.sourceCommit!==expected.commit||result.runtimeDigest!==input.runtimeDigest||result.policyImplementationId!==input.policyImplementationId
  ||result.executorSha256!==expected.executorSha256||result.managerSha256!==expected.managerSha256)reject('Result identity differs from fixed source/input');
 if(!Array.isArray(result.identities)||result.identities.length!==4||!Array.isArray(result.workers)||result.workers.length!==4)reject('Missing native producer identities');
 for(let part=0;part<4;part++){
  const identity=result.identities.find(x=>x.part===part),worker=result.workers.find(x=>x.part===part);
  if(!identity||identity.id!==input.id||identity.workloadSha256!==expected.inputSha256||identity.executorSha256!==expected.executorSha256
   ||identity.runtimeDigest!==input.runtimeDigest||identity.policyImplementationId!==input.policyImplementationId||identity.node!==input.node||identity.v8!==input.v8
   ||identity.uid!==2000||identity.linuxFence?.held!==true||!worker||worker.id!==input.id||worker.linuxFence?.held!==true
   ||worker.cache?.enabled!==true)reject('Native Linux producer/fence identity mismatch');
 }
 const candidates=new Set(input.candidates.map(c=>c.candidateId)),slots=new Set();
 if(!Array.isArray(result.outcomes)||result.outcomes.length!==32*candidates.size)reject('Incomplete fixed cohort');
 for(const slot of result.outcomes){
  if(Object.keys(slot).sort().join(',')!=='candidateId,complete,plies,sampleIndex,seeds,winner'||slot.complete!==true
   ||!Number.isSafeInteger(slot.sampleIndex)||slot.sampleIndex<0||slot.sampleIndex>=32||!candidates.has(slot.candidateId)
   ||!['white','dark'].includes(slot.winner)||!Number.isSafeInteger(slot.plies)||slot.plies<0||slot.plies>input.limits.maxPlies
   ||!slot.seeds||Object.keys(slot.seeds).sort().join(',')!=='dark,white'
   ||slot.seeds.white!==input.seedsBySample[slot.sampleIndex].white||slot.seeds.dark!==input.seedsBySample[slot.sampleIndex].dark)reject('Invalid native endpoint');
  const key=slot.sampleIndex+':'+slot.candidateId;if(slots.has(key))reject('Duplicate native endpoint');slots.add(key);
 }
 for(let sample=0;sample<32;sample++)for(const id of candidates)if(!slots.has(sample+':'+id))reject('Missing fixed native endpoint');
 return{complete:true,endpoints:slots.size,manifestId:input.manifestId,sourceCommit:expected.commit};
}
module.exports={validate,sha};
