'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validate}=require('../ops/terminal-compute/validate-native-results.cjs');
function fixture(){
 const input={id:'case',manifestId:'manifest',runtimeDigest:'runtime',policyImplementationId:'policy',node:'24.15.0',v8:'pinned',limits:{maxPlies:320},candidates:[{candidateId:'a'},{candidateId:'b'}],seedsBySample:Array.from({length:32},(_,i)=>({white:i+1,dark:i+100}))};
 const expected={inputSha256:'input',commit:'commit',executorSha256:'executor',managerSha256:'manager'};
 const result={schema:'long-requested-attested-native-endpoints-v1',complete:true,id:input.id,manifestId:input.manifestId,inputSha256:'input',sourceCommit:'commit',runtimeDigest:'runtime',policyImplementationId:'policy',executorSha256:'executor',managerSha256:'manager',identities:[],workers:[],outcomes:[]};
 for(let part=0;part<4;part++){result.identities.push({part,id:'case',workloadSha256:'input',executorSha256:'executor',runtimeDigest:'runtime',policyImplementationId:'policy',node:input.node,v8:input.v8,uid:2000,linuxFence:{held:true}});result.workers.push({part,id:'case',linuxFence:{held:true},cache:{enabled:true}});}
 for(let sampleIndex=0;sampleIndex<32;sampleIndex++)for(const candidate of input.candidates)result.outcomes.push({sampleIndex,candidateId:candidate.candidateId,seeds:input.seedsBySample[sampleIndex],winner:'dark',plies:150,complete:true});
 return{input,result,expected};
}
test('accepts only the complete predeclared cohort bound to a verified producer commit',()=>{const f=fixture();assert.equal(validate(f.result,f.input,f.expected).endpoints,64);});
for(const [name,mutate]of Object.entries({
 'partial cohort':f=>f.result.outcomes.pop(),
 'duplicate sample':f=>f.result.outcomes[1]=f.result.outcomes[0],
 'changed dice':f=>f.result.outcomes[0]={...f.result.outcomes[0],seeds:{white:900,dark:901}},
 'different native runtime':f=>f.result.identities[0].runtimeDigest='another',
 'different executor':f=>f.result.executorSha256='another',
 'different source commit':f=>f.result.sourceCommit='another',
 'missing kernel lock':f=>f.result.identities[0].linuxFence.held=false,
 'untrusted extra result field':f=>f.result.outcomes[0].label='win',
 'nonterminal sample':f=>f.result.outcomes[0].complete=false,
 'wrong candidate':f=>f.result.outcomes[0].candidateId='c',
 'censored game':f=>f.result.outcomes[0].plies=321,
 'missing native process':f=>f.result.workers[0].part=1,
}))test('rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>validate(f.result,f.input,f.expected));});
