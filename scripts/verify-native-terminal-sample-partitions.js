'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
async function verify(root,output){
 const shadow=require(path.join(root,'scripts/generate-long-bot-shadow-replay'));
 const paired=require(path.join(root,'scripts/long-bot-paired-rollout'));
 const worker=require(path.join(root,'scripts/long-bot-causal-worker'));
 const initial=shadow.loadRuntime(),{game,engine}=initial;
 engine.setExperience([],'server-causal-rollout');const state=game.initialState('long');
 Object.assign(state,{turn:'dark',phase:'move',dice:[1,2],rolled:[1,2],points:{13:{color:'dark',count:2},18:{color:'dark',count:1},6:{color:'white',count:1}},off:{white:14,dark:12},bar:{white:0,dark:0},firstMoveDone:{white:true,dark:true},headPlayedThisTurn:{white:false,dark:false},turnMoves:[],history:[]});
 engine.plan(state,paired.DEFAULT_ROLLOUT_LIMITS.policy);const decision=engine.consumeLastDecision(),unique=new Map();
 for(const moves of game.bestMoveSequences(state,state.turn)){const after=shadow.applyLegalSequence(game,state,moves);if(!after)throw Error('Invalid native root action');if(!unique.has(shadow.afterPositionKey(after)))unique.set(shadow.afterPositionKey(after),{moves,after});}
 const control=unique.get(shadow.afterPositionKey(decision.selected)),alternative=[...unique.values()].filter(c=>shadow.afterPositionKey(c)!==shadow.afterPositionKey(control)).sort((a,b)=>a.after.off.dark-b.after.off.dark)[0];
 if(!control||!alternative)throw Error('Distinct native actions required');const candidates=[control,alternative];
 const stateId=crypto.createHash('sha256').update('nardu/long-causal-rollout/state/v1\0'+shadow.stableStringify(decision.stateSnapshotV2)).digest('hex');
 const seeds=Array.from({length:32},(_,i)=>paired.derivePairedSeeds(stateId,i)),limits=paired.normalizedLimits();
 async function collect(groups){const values=new Map();for(const indexes of groups){
  shadow.clearRuntimeCache();const runtime=shadow.loadRuntime();runtime.engine.setExperience([],'server-causal-rollout');
  const cache=paired.createNativeColdCohortCache(runtime,limits,{runtimeDigest:worker.runtimeDigest(),policyImplementationId:worker.policyImplementationId(),gameBytesDigest:runtime.gameBytesDigest,runtimeBytesDigest:runtime.runtimeBytesDigest});
  if(!cache.enabled())throw Error('Actual native cache guard refused');
  for(const index of indexes)for(const [side,candidate]of candidates.entries()){
   const result=paired.playTerminalRollout(runtime,paired.applyCompleteAction(runtime,decision,candidate),'dark',seeds[index],limits,Date.now(),{nativeCache:cache,nativeHistoryProjection:true});
   if(!result.complete)throw Error('Native endpoint incomplete');const key=index+':'+side;if(values.has(key))throw Error('Repeated endpoint');values.set(key,{winner:result.winner,plies:result.plies});
  }
 }return Object.fromEntries([...values].sort(([a],[b])=>a.localeCompare(b)));}
 const original=await collect(Array.from({length:4},(_,part)=>Array.from({length:8},(_,i)=>part+4*i)));
 const partitioned=await collect([0,8,16,24].flatMap(start=>Array.from({length:4},(_,part)=>[start+part,start+part+4])));
 if(Object.keys(original).length!==64||shadow.stableStringify(original)!==shadow.stableStringify(partitioned))throw Error('Sample partition changed native winner/plies vectors');
 const report={schema:'native-fixed-sample-partition-equivalence-v1',productionEvidence:false,checkedAt:new Date().toISOString(),nativeRuntimeDigest:worker.runtimeDigest(),policyImplementationId:worker.policyImplementationId(),node:process.versions.node,v8:process.versions.v8,declaredSamples:32,alternatives:2,completeEndpointVectorsCompared:2,terminalEndpointsPerVector:64,allWinnersAndPliesIdentical:true,original,partitioned};
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');return report;
}
if(require.main===module)verify(path.resolve(process.argv[2]),path.resolve(process.argv[3])).then(r=>console.log(JSON.stringify({allWinnersAndPliesIdentical:r.allWinnersAndPliesIdentical,nativeRuntimeDigest:r.nativeRuntimeDigest,terminalEndpointsPerVector:r.terminalEndpointsPerVector}))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={verify};
