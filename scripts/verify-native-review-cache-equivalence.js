'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
async function experiment(root,repeat){
 const shadow=require(path.join(root,'scripts/generate-long-bot-shadow-replay'));
 const paired=require(path.join(root,'scripts/long-bot-paired-rollout'));
 const w=require(path.join(root,'scripts/long-bot-causal-worker'));
 const runtime=shadow.loadRuntime(),{game,engine}=runtime;
 engine.beginExperienceSession('review-cache-equivalence');engine.setExperience([],'server');
 const state=game.initialState('long');Object.assign(state,{turn:'dark',phase:'move',dice:[1,2],rolled:[1,2],
  points:{13:{color:'dark',count:2},18:{color:'dark',count:1},6:{color:'white',count:1}},
  off:{white:14,dark:12},bar:{white:0,dark:0},firstMoveDone:{white:true,dark:true},headPlayedThisTurn:{white:false,dark:false},turnMoves:[],history:[]});
 engine.plan(state,paired.DEFAULT_ROLLOUT_LIMITS.policy);const decision=engine.consumeLastDecision();
 const choices=new Map();for(const moves of game.bestMoveSequences(state,state.turn)){const after=shadow.applyLegalSequence(game,state,moves);if(!after)throw Error('Invalid native action');if(!choices.has(shadow.afterPositionKey(after)))choices.set(shadow.afterPositionKey(after),{moves,after});}
 const control=choices.get(shadow.afterPositionKey(decision.selected));
 const alternative=[...choices.values()].filter(c=>shadow.afterPositionKey(c)!==shadow.afterPositionKey(control)).sort((a,b)=>a.after.off.dark-b.after.off.dark)[0];
 if(!control||!alternative)throw Error('Expected distinct real choices');
 const identity={runtimeDigest:w.runtimeDigest(),policyImplementationId:w.policyImplementationId(),gameSha256:runtime.gameBytesDigest,bundleSha256:runtime.runtimeBytesDigest};
 const options={nativeCacheAttestation:{runtimeDigest:identity.runtimeDigest,policyImplementationId:identity.policyImplementationId,gameBytesDigest:identity.gameSha256,runtimeBytesDigest:identity.bundleSha256}};
 const results=[];for(let index=0;index<repeat;index++){
  const r=await paired.generatePairedPolicyOutcomes(decision,[control,alternative],options);if(!r.ok||!r.coverage.complete)throw Error('Incomplete native cohort: '+r.reason);
  results.push({coverage:r.coverage,seedFingerprint:r.seedFingerprint,policyFingerprint:r.policyFingerprint,regret:r.regret,regretLcb:r.regretLcb,
   candidates:r.candidates.map(c=>({key:shadow.afterPositionKey(c),wins:c.rolloutWins,samples:c.rolloutSamples,outcomeFingerprint:c.outcomeFingerprint,lower:c.policyScoreLcb,upper:c.policyScoreUcb})),cache:r.cacheObservation});
 }
 return{identity,stateSnapshot:decision.stateSnapshotV2,results};
}
async function verify(baseline,cached,output){
 const old=await experiment(baseline,1),updated=await experiment(cached,2);
 if(old.identity.policyImplementationId!==updated.identity.policyImplementationId||old.identity.gameSha256!==updated.identity.gameSha256||old.identity.bundleSha256!==updated.identity.bundleSha256)throw Error('Gaming policy/rules changed');
 const core=r=>JSON.stringify({coverage:r.coverage,seeds:r.seedFingerprint,policy:r.policyFingerprint,regret:r.regret,regretLcb:r.regretLcb,candidates:r.candidates});
 if(core(old.results[0])!==core(updated.results[0])||core(updated.results[0])!==core(updated.results[1]))throw Error('Native terminal vectors or confidence changed');
 if(updated.results[1].cache.planMisses!==updated.results[0].cache.planMisses||updated.results[1].cache.suffixHits<updated.results[0].cache.suffixHits+64)throw Error('No cache reuse across complete calls');
 const report={schema:'native-review-process-cache-equivalence-v1',productionEvidence:false,checkedAt:new Date().toISOString(),policyUnchanged:true,rulesUnchanged:true,bundleUnchanged:true,
  terminalCohorts:3,terminalOutcomesPerCohort:64,completeWinnerVectorsIdentical:true,confidenceBoundsIdentical:true,baseline:old,cached:updated};
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');return report;
}
if(require.main===module)verify(process.argv[2],process.argv[3],process.argv[4]).then(r=>console.log(JSON.stringify({policyUnchanged:r.policyUnchanged,completeWinnerVectorsIdentical:r.completeWinnerVectorsIdentical,cohorts:r.terminalCohorts,oldRuntime:r.baseline.identity.runtimeDigest,newRuntime:r.cached.identity.runtimeDigest}))).catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={verify};
