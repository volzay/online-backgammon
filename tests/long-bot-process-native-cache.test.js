'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createProcessNativeCacheProvider,generatePairedPolicyOutcomes,DEFAULT_ROLLOUT_LIMITS}=require('../scripts/long-bot-paired-rollout');
const {loadRuntime,applyLegalSequence,afterPositionKey}=require('../scripts/generate-long-bot-shadow-replay');
const w=require('../scripts/long-bot-causal-worker');
test('process cache reuses only the same native VM and namespace with live guards',()=>{
 let created=0;const provider=createProcessNativeCacheProvider((runtime,limits,attestation)=>({number:++created,
  observation:()=>({namespaceFingerprint:attestation.namespace}),enabled:()=>runtime.valid!==false}));
 const a={},b={};const one=provider(a,{}, {namespace:'A'});assert.equal(provider(a,{}, {namespace:'A'}),one);
 assert.notEqual(provider(b,{}, {namespace:'A'}),one,'another VM cannot borrow plans even with identical advertised bytes');
 const next=provider(a,{}, {namespace:'A'});a.valid=false;assert.notEqual(provider(a,{}, {namespace:'A'}),next);
});
test('process cache bounds retained namespaces and never revives a disabled entry',()=>{
 let created=0;const provider=createProcessNativeCacheProvider((runtime,limits,attestation)=>({number:++created,
  observation:()=>({namespaceFingerprint:attestation.namespace}),enabled:()=>runtime.valid!==false}),2);
 const vm={};const first=provider(vm,{}, {namespace:'A'});provider(vm,{}, {namespace:'B'});provider(vm,{}, {namespace:'C'});
 assert.notEqual(provider(vm,{}, {namespace:'A'}),first,'the oldest of more than two namespaces is evicted');
 assert.throws(()=>createProcessNativeCacheProvider(()=>{},100));
});
test('two complete real native cohorts retain identical terminal vectors while avoiding repeated planning',async()=>{
 const runtime=loadRuntime(),{game,engine}=runtime;engine.beginExperienceSession('process-cache-native-proof');engine.setExperience([],'server');
 const state=game.initialState('long');Object.assign(state,{turn:'dark',phase:'move',dice:[1,2],rolled:[1,2],
  points:{13:{color:'dark',count:2},14:{color:'dark',count:1},6:{color:'white',count:1}},
  off:{white:14,dark:12},bar:{white:0,dark:0},firstMoveDone:{white:true,dark:true},headPlayedThisTurn:{white:false,dark:false},turnMoves:[],history:[]});
 engine.plan(state,DEFAULT_ROLLOUT_LIMITS.policy);const decision=engine.consumeLastDecision();
 const unique=new Map();for(const moves of game.bestMoveSequences(state,state.turn)){const after=applyLegalSequence(game,state,moves);assert.ok(after);if(!unique.has(afterPositionKey(after)))unique.set(afterPositionKey(after),{moves,after});}
 const control=unique.get(afterPositionKey(decision.selected));assert.ok(control);const other=[...unique.values()].find(c=>afterPositionKey(c)!==afterPositionKey(control));assert.ok(other);
 const candidates=[control,other],attestation={runtimeDigest:w.runtimeDigest(),policyImplementationId:engine.policyImplementationId,
  gameBytesDigest:runtime.gameBytesDigest,runtimeBytesDigest:runtime.runtimeBytesDigest};
 const first=await generatePairedPolicyOutcomes(decision,candidates,{nativeCacheAttestation:attestation});
 const second=await generatePairedPolicyOutcomes(decision,candidates,{nativeCacheAttestation:attestation});
 assert.equal(first.ok,true,first.reason);assert.equal(second.ok,true,second.reason);
 assert.equal(first.coverage.terminalOutcomes,64);assert.equal(second.coverage.terminalOutcomes,64);
 const outcomes=r=>r.candidates.map(c=>({position:afterPositionKey(c),wins:c.rolloutWins,samples:c.rolloutSamples,fingerprint:c.outcomeFingerprint,lower:c.policyScoreLcb,upper:c.policyScoreUcb}));
 assert.deepEqual(outcomes(second),outcomes(first));assert.equal(second.regretLcb,first.regretLcb);
 assert.equal(second.cacheObservation.planMisses,first.cacheObservation.planMisses,'all already authenticated deterministic suffixes are reusable');
 assert.ok(second.cacheObservation.suffixHits>=first.cacheObservation.suffixHits+64);
});
