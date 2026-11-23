'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function validateCore(result,input,expected,sampleStart,sampleEnd,fragment){
 const reject=message=>{throw Error(message);};
 if(result.schema!==(fragment?'long-requested-attested-native-fragment-v1':'long-requested-attested-native-endpoints-v1')
  ||result.complete!==(fragment?false:true)||(fragment&&result.fragmentComplete!==true)||result.error
  ||result.id!==input.id||result.inputSha256!==expected.inputSha256||result.manifestId!==input.manifestId
  ||result.sourceCommit!==expected.commit||result.runtimeDigest!==input.runtimeDigest||result.policyImplementationId!==input.policyImplementationId
  ||result.executorSha256!==expected.executorSha256||result.managerSha256!==expected.managerSha256)reject('Result identity differs from fixed source/input');
 if(!Array.isArray(result.identities)||result.identities.length!==4||!Array.isArray(result.workers)||result.workers.length!==4)reject('Missing native producer identities');
 for(let part=0;part<4;part++){
  const identity=result.identities.find(x=>x.part===part),worker=result.workers.find(x=>x.part===part);
  if(!identity||identity.id!==input.id||identity.workloadSha256!==expected.inputSha256||identity.executorSha256!==expected.executorSha256
   ||identity.runtimeDigest!==input.runtimeDigest||identity.policyImplementationId!==input.policyImplementationId||identity.node!==input.node||identity.v8!==input.v8
   ||(fragment&&(identity.sampleStart!==sampleStart||identity.sampleEnd!==sampleEnd))
   ||identity.uid!==2000||identity.linuxFence?.held!==true||!worker||worker.id!==input.id||worker.linuxFence?.held!==true
   ||worker.cache?.enabled!==true)reject('Native Linux producer/fence identity mismatch');
 }
 const candidates=new Set(input.candidates.map(c=>c.candidateId)),slots=new Set();
 if(!Array.isArray(result.outcomes)||result.outcomes.length!==(sampleEnd-sampleStart)*candidates.size)reject('Incomplete fixed sample range');
 for(const slot of result.outcomes){
  if(Object.keys(slot).sort().join(',')!=='candidateId,complete,plies,sampleIndex,seeds,winner'||slot.complete!==true
   ||!Number.isSafeInteger(slot.sampleIndex)||slot.sampleIndex<sampleStart||slot.sampleIndex>=sampleEnd||!candidates.has(slot.candidateId)
   ||!['white','dark'].includes(slot.winner)||!Number.isSafeInteger(slot.plies)||slot.plies<0||slot.plies>input.limits.maxPlies
   ||!slot.seeds||Object.keys(slot.seeds).sort().join(',')!=='dark,white'
   ||slot.seeds.white!==input.seedsBySample[slot.sampleIndex].white||slot.seeds.dark!==input.seedsBySample[slot.sampleIndex].dark)reject('Invalid native endpoint');
  const key=slot.sampleIndex+':'+slot.candidateId;if(slots.has(key))reject('Duplicate native endpoint');slots.add(key);
 }
 for(let sample=sampleStart;sample<sampleEnd;sample++)for(const id of candidates)if(!slots.has(sample+':'+id))reject('Missing fixed native endpoint');
 return{complete:!fragment,fragmentComplete:fragment,endpoints:slots.size,manifestId:input.manifestId,sourceCommit:expected.commit};
}
function validate(result,input,expected){return validateCore(result,input,expected,0,32,false);}
function validateFragment(result,input,expected){
 const f=result.fragment;if(!f||Object.keys(f).sort().join(',')!=='declaredCohortSamples,sampleEnd,sampleStart'
  ||f.declaredCohortSamples!==32||![0,8,16,24].includes(f.sampleStart)||f.sampleEnd!==f.sampleStart+8)throw Error('Original fixed fragment range required');
 return validateCore(result,input,expected,f.sampleStart,f.sampleEnd,true);
}
function validateFragments(results,input,expected){
 if(!Array.isArray(results)||results.length!==4)throw Error('All four fixed fragments required before cohort completion');
 const ranges=new Set(),slots=new Set(),outcomes=[];
 for(const result of results){validateFragment(result,input,expected);if(ranges.has(result.fragment.sampleStart))throw Error('Repeated native fragment');ranges.add(result.fragment.sampleStart);
  for(const slot of result.outcomes){const key=slot.sampleIndex+':'+slot.candidateId;if(slots.has(key))throw Error('Repeated native endpoint across fragments');slots.add(key);outcomes.push(slot);}}
 if(ranges.size!==4||slots.size!==32*input.candidates.length)throw Error('Incomplete original native cohort');
 for(let sample=0;sample<32;sample++)for(const c of input.candidates)if(!slots.has(sample+':'+c.candidateId))throw Error('Missing original fixed sample');
 return{schema:'long-verified-native-fragment-union-v1',complete:true,endpoints:slots.size,fragments:4,declaredSamples:32,outcomes};
}
module.exports={validate,validateFragment,validateFragments,sha};
