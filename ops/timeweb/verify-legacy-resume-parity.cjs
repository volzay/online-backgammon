'use strict';
// Synthetic diagnostic only. Forced process-boundary interruptions must not
// alter the original policy's terminal winner or total number of plies.
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const OLD='/opt/online-backgammon-causal-worker.pre-ac943a4-20260919T0630Z',NEW='/opt/online-backgammon-causal-recovery-fcdc-v2-20261123';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
if(process.platform!=='linux'||process.getuid()!==0)throw Error('Private operator test required');
const oldW=require(OLD+'/scripts/long-bot-causal-worker'),newW=require(NEW+'/scripts/long-bot-causal-worker');
assert.equal(oldW.policyImplementationId(),newW.policyImplementationId());
const oldRuntime=require(OLD+'/scripts/generate-long-bot-shadow-replay').loadRuntime(),newRuntime=require(NEW+'/scripts/generate-long-bot-shadow-replay').loadRuntime();
const oldQ=require(OLD+'/scripts/long-bot-paired-rollout'),newQ=require(NEW+'/scripts/long-bot-paired-rollout');
assert.deepEqual(oldQ.DEFAULT_ROLLOUT_LIMITS,newQ.DEFAULT_ROLLOUT_LIMITS);
for(const r of [oldRuntime,newRuntime])r.engine.setExperience([],'server-causal-rollout');
const state=oldRuntime.game.initialState('long');Object.assign(state,{phase:'roll',turn:'dark',winner:null,resultType:null,
 points:{16:{color:'dark',count:1},17:{color:'dark',count:1},5:{color:'white',count:1},6:{color:'white',count:1}},
 off:{white:13,dark:13},bar:{white:0,dark:0},dice:[],rolled:[],turnMoves:[],history:[],
 firstMoveDone:{white:true,dark:true},headPlayedThisTurn:{white:false,dark:false}});
const seeds=Array.from({length:32},(_,i)=>oldQ.derivePairedSeeds(sha('synthetic-legacy-resume-parity-only'),i));
const candidateId=sha('synthetic-only-candidate'),directory='/var/lib/online-backgammon-expanded-study-20261123/legacy-parity-'+Date.now();
fs.mkdirSync(directory,{mode:0o700});const journal=require(NEW+'/scripts/long-bot-terminal-journal').createTerminalJournal({directory:directory+'/journal',manifest:{
 schema:'long-bot-terminal-cohort-manifest-v1',sampleCount:32,candidateIds:[candidateId,sha('unused-synthetic-neighbor')],seedsBySample:seeds,botColor:'dark',maxPlies:320,
 bindings:{schema:'synthetic-native-resume-parity-only',productionEvidence:false}}});
let boundaries=0;const boundary=Object.freeze({syntheticBoundary:true});
for(let i=0;i<4;i++){
 const expected=oldQ.playTerminalRollout(oldRuntime,state,'dark',seeds[i],oldQ.DEFAULT_ROLLOUT_LIMITS,Date.now());assert.equal(expected.complete,true);
 let actual;
 for(let tries=0;tries<320;tries++){
  try{actual=newQ.playTerminalRollout(newRuntime,state,'dark',seeds[i],newQ.DEFAULT_ROLLOUT_LIMITS,Date.now(),{
   resumeCheckpoint:journal.lookupCheckpoint(i,candidateId,seeds[i]),saveCheckpoint:next=>{
    journal.saveCheckpoint({sampleIndex:i,candidateId,seeds:seeds[i],...next});boundaries++;throw boundary;}});}
  catch(error){if(error!==boundary)throw error;continue;}
  assert.equal(actual.complete,true);break;
 }
 assert.ok(actual?.complete);assert.equal(actual.winner,expected.winner);assert.equal(actual.plies,expected.plies);
 journal.commit({sampleIndex:i,candidateId,seeds:seeds[i],winner:actual.winner,plies:actual.plies,complete:true});
}
const observation=journal.observation();journal.close();assert(boundaries>0);assert.equal(observation.complete,false);assert.equal(observation.learningEvidence,false);
const report={schema:'synthetic-original-policy-resume-parity-v1',cases:4,authenticatedResumeBoundaries:boundaries,
 sameWinnerAndTotalPlies:true,policyImplementationId:newW.policyImplementationId(),oldRuntime:oldW.runtimeDigest(),newRuntime:newW.runtimeDigest(),
 statisticalLimitsUnchanged:true,productionEvidence:false,syntheticOnly:true};
fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(report));
