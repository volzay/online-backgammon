'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validate,validateFragment,validateFragments}=require('../ops/terminal-compute/validate-native-results.cjs');
function fixture(){
 const input={id:'case',manifestId:'manifest',runtimeDigest:'runtime',policyImplementationId:'policy',node:'24.15.0',v8:'pinned',limits:{maxPlies:320},candidates:[{candidateId:'a'},{candidateId:'b'}],seedsBySample:Array.from({length:32},(_,i)=>({white:i+1,dark:i+100}))};
 const expected={inputSha256:'input',commit:'commit',executorSha256:'executor',managerSha256:'manager'};
 const results=[0,8,16,24].map(sampleStart=>{
  const r={schema:'long-requested-attested-native-fragment-v1',complete:false,fragmentComplete:true,fragment:{sampleStart,sampleEnd:sampleStart+8,declaredCohortSamples:32},id:'case',manifestId:'manifest',inputSha256:'input',sourceCommit:'commit',runtimeDigest:'runtime',policyImplementationId:'policy',executorSha256:'executor',managerSha256:'manager',identities:[],workers:[],outcomes:[]};
  for(let part=0;part<4;part++){r.identities.push({part,sampleStart,sampleEnd:sampleStart+8,id:'case',workloadSha256:'input',executorSha256:'executor',runtimeDigest:'runtime',policyImplementationId:'policy',node:input.node,v8:input.v8,uid:2000,linuxFence:{held:true}});r.workers.push({part,id:'case',linuxFence:{held:true},cache:{enabled:true}});}
  for(let sampleIndex=sampleStart;sampleIndex<sampleStart+8;sampleIndex++)for(const c of input.candidates)r.outcomes.push({sampleIndex,candidateId:c.candidateId,seeds:input.seedsBySample[sampleIndex],winner:sampleIndex%2?'white':'dark',plies:150,complete:true});return r;
 });return{input,expected,results};
}
test('one completed assigned range is never accepted as a complete native cohort',()=>{const f=fixture();assert.equal(validateFragment(f.results[0],f.input,f.expected).complete,false);assert.throws(()=>validate(f.results[0],f.input,f.expected));assert.throws(()=>validateFragments([f.results[0]],f.input,f.expected));});
test('all four disjoint prespecified ranges recover exactly the original 32 samples',()=>{const f=fixture(),r=validateFragments(f.results,f.input,f.expected);assert.equal(r.complete,true);assert.equal(r.endpoints,64);assert.deepEqual([...new Set(r.outcomes.map(x=>x.sampleIndex))].sort((a,b)=>a-b),Array.from({length:32},(_,i)=>i));});
for(const [name,change]of Object.entries({
 'missing original sample':f=>f.results[0].outcomes.pop(),
 'duplicate range':f=>f.results[1]=structuredClone(f.results[0]),
 'wrong sample interval':f=>f.results[1].fragment.sampleStart=9,
 'smaller declared cohort':f=>f.results[0].fragment.declaredCohortSamples=8,
 'invented completion':f=>f.results[0].complete=true,
 'different source commit':f=>f.results[0].sourceCommit='different',
 'different native policy':f=>f.results[0].runtimeDigest='different',
 'different dice stream':f=>f.results[0].outcomes[0].seeds={white:999,dark:998},
 'duplicate endpoint':f=>f.results[0].outcomes[1]=structuredClone(f.results[0].outcomes[0]),
 'native process outside assigned scope':f=>f.results[0].identities[0].sampleStart=8,
}))test('fragment union rejects '+name,()=>{const f=fixture();change(f);assert.throws(()=>validateFragments(f.results,f.input,f.expected));});
