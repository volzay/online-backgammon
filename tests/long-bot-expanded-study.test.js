'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {evaluateCase}=require('../lib/long-bot-expanded-study-confidence');
const {validate}=require('../ops/terminal-expansion/validate-fragment.cjs');
const protocol=require('../ops/terminal-expansion/protocol.json');
const input=require('../ops/terminal-expansion/workloads/LEM5-RES8-t3.json');
function outcomes(n,better){return Array.from({length:n},(_,sampleIndex)=>input.candidates.map(c=>({sampleIndex,
 candidateId:c.candidateId,seeds:input.seedsBySample[sampleIndex],complete:true,
 winner:better&&c.candidateId!==input.controlId?'white':'dark'}))).flat();}
test('fixed study rejects partial looks, duplicate pairs, changed dice and weaker allocations',()=>{
 const rows=outcomes(128,false);
 assert.throws(()=>evaluateCase(input,rows.slice(1),protocol,128),/Complete/);
 assert.throws(()=>evaluateCase(input,[rows[0],...rows.slice(0,-1)],protocol,128),/Duplicate/);
 const changed=structuredClone(rows);changed[0].seeds.white++;
 assert.throws(()=>evaluateCase(input,changed,protocol,128),/Invalid native/);
 for(const patch of [{positiveCaseAlpha:0.05},{pairedComparisonAlpha:0.05},{minEffectLowerBound:0.01},{stages:[32,128]}])
  assert.throws(()=>evaluateCase(input,rows,{...protocol,...patch},128),/binding/);
});
test('synthetic known large improvement passes both bounds; identical outcomes never become a lesson',()=>{
 const improved=outcomes(128,false).map(r=>({...r,winner:r.candidateId===input.controlId
  ?(input.botColor==='white'?'dark':'white'):input.botColor}));
 const yes=evaluateCase(input,improved,protocol,128);
 assert.equal(yes.conclusion,'confirmed');assert(yes.comparisons[0].originalHoeffdingLower>0.08);
 assert(yes.comparisons[0].pairedLower>0.08);
 const no=evaluateCase(input,outcomes(128,false),protocol,128);
 assert.equal(no.comparisons[0].confirmed,false);assert.equal(no.conclusion,'effect-at-least-eight-points-excluded');
 assert.equal(no.terminalEvidenceForOtherPolicies,false);
});
test('sealed fragment structural check rejects unfenced, foreign and censored results',()=>{
 const expected={commit:'a'.repeat(40),inputSha256:'b',executorSha256:'c',managerSha256:'d',capsules:{old:'unchanged'}};
 const r={schema:'long-expanded-attested-native-fragment-v1',id:input.id+'-s0',cohort:input.id,start:0,end:32,
  fragmentComplete:true,studyComplete:false,sourceCommit:expected.commit,executorSha256:'c',managerSha256:'d',inputSha256:'b',
  runtimeDigest:input.runtimeDigest,policyImplementationId:input.policyImplementationId,capsules:expected.capsules,
  identities:Array.from({length:4},(_,part)=>({part,uid:2000,node:input.node,v8:input.v8,id:input.id,start:0,end:32,
   runtimeDigest:input.runtimeDigest,policyImplementationId:input.policyImplementationId,inputSha256:'b',executorSha256:'c',linuxFence:{held:true}})),
  workers:Array.from({length:4},(_,part)=>({part,id:input.id,start:0,end:32,linuxFence:{held:true},cache:{enabled:true}})),
  outcomes:outcomes(32,false).map(x=>({...x,localSampleIndex:x.sampleIndex,plies:1}))};
 assert.equal(validate(r,input,expected).endpoints,64);
 for(const mutate of [x=>x.identities[0].linuxFence.held=false,x=>x.outcomes[0].complete=false,
  x=>x.outcomes[0].seeds.white++,x=>x.workers[0].start=32,x=>x.sourceCommit='e'.repeat(40),x=>x.outcomes.push(x.outcomes[0])]){
  const changed=structuredClone(r);mutate(changed);assert.throws(()=>validate(changed,input,expected));
 }
});
test('published workloads preserve empty histories, fixed seeds and protocol file lock',()=>{
 const {execFileSync}=require('node:child_process');
 const output=execFileSync(process.execPath,['ops/terminal-expansion/verify-inputs.cjs'],{cwd:require('node:path').join(__dirname,'..'),encoding:'utf8'});
 assert.match(output,/"anonymousDatasets":15/);
 for(const c of protocol.cases){const x=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../ops/terminal-expansion/workloads/'+c.id+'.json')));
  assert.equal(x.seedsBySample.length,1024);assert.equal(x.state.history.length,0);
  assert.equal(new Set(x.seedsBySample.flatMap(s=>[s.white,s.dark])).size,2048);
 }
});
