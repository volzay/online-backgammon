'use strict';
const crypto=require('crypto');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function validate(result,input,expected){
 if(!result||result.schema!=='long-expanded-attested-native-fragment-v1'||result.cohort!==input.id
  ||result.id!==input.id+'-s'+result.start||result.fragmentComplete!==true||result.studyComplete!==false
  ||result.sourceCommit!==expected.commit||result.executorSha256!==expected.executorSha256||result.managerSha256!==expected.managerSha256
  ||result.inputSha256!==expected.inputSha256||result.runtimeDigest!==input.runtimeDigest||result.policyImplementationId!==input.policyImplementationId
  ||result.error||!Number.isSafeInteger(result.start)||result.start<0||result.start>992||result.start%32||result.end!==result.start+32
  ||JSON.stringify(result.capsules)!==JSON.stringify(expected.capsules))throw Error('Native fragment identity/completeness differs');
 if(!Array.isArray(result.identities)||result.identities.length!==4||!Array.isArray(result.workers)||result.workers.length!==4)throw Error('Four fenced native processes required');
 for(let part=0;part<4;part++){
  const ids=result.identities.filter(r=>r.part===part),workers=result.workers.filter(r=>r.part===part);
  if(ids.length!==1||workers.length!==1)throw Error('Duplicate/missing native process');
  const r=ids[0];if(r.uid!==2000||r.node!==input.node||r.v8!==input.v8||r.id!==input.id||r.start!==result.start||r.end!==result.end
   ||r.runtimeDigest!==input.runtimeDigest||r.policyImplementationId!==input.policyImplementationId||r.inputSha256!==expected.inputSha256
   ||r.executorSha256!==expected.executorSha256||r.linuxFence?.held!==true||workers[0].linuxFence?.held!==true
   ||workers[0].cache?.enabled!==true||workers[0].id!==input.id||workers[0].start!==result.start||workers[0].end!==result.end)throw Error('Native Linux execution identity differs');
 }
 const slots=new Set();if(!Array.isArray(result.outcomes)||result.outcomes.length!==32*input.candidates.length)throw Error('Incomplete fixed range');
 for(const r of result.outcomes){
  if(!Number.isSafeInteger(r.sampleIndex)||r.sampleIndex<result.start||r.sampleIndex>=result.end
   ||r.localSampleIndex!==r.sampleIndex-result.start||!input.candidates.some(c=>c.candidateId===r.candidateId)
   ||JSON.stringify(r.seeds)!==JSON.stringify(input.seedsBySample[r.sampleIndex])||r.complete!==true
   ||!['white','dark'].includes(r.winner)||!Number.isSafeInteger(r.plies)||r.plies<0||r.plies>input.limits.maxPlies)throw Error('Censored, foreign or changed native slot');
  const key=r.sampleIndex+':'+r.candidateId;if(slots.has(key))throw Error('Duplicate native slot');slots.add(key);
 }
 return {completeFragment:true,endpoints:slots.size,studyComplete:false,sourceCommit:expected.commit};
}
module.exports={validate,sha};
