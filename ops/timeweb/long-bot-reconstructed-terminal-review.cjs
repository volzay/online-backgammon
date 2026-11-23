'use strict';
// Server-owned terminal diagnostics on independently replayed historical
// boards. Fresh cold decisions are explicitly not original archived records.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const APP='/opt/online-backgammon-live-transfer-7a263bcd-r2';
const w=require(APP+'/scripts/long-bot-causal-worker');
const model=require(APP+'/scripts/long-bot-board-model-worker');
const {loadRuntime,applyLegalSequence,afterPositionKey,canonicalMoveKey,stableStringify}=require(APP+'/scripts/generate-long-bot-shadow-replay');
const paired=require(APP+'/scripts/long-bot-paired-rollout');
const EXPECTED_POLICY='7a263bcd3a44b7248b1b369e18dd552f1a5053e4f0772561f13c9a95e56abfa7';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const codeHash=sha(fs.readFileSync(__filename));
function save(file,value){const temporary=file+'.next';fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,file);}
async function prepare(file){
 if(fs.existsSync(file))return read(file);
 const identity=model.identity({production:true});if(identity.policyImplementationId!==EXPECTED_POLICY)throw Error('Unexpected current cold policy');
 const source=await w.supabaseRpc(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,
  'next_long_bot_board_review',{p_policy:identity.policyImplementationId,p_runtime:identity.runtimeDigest,p_rooms:['LEM5-RES8']});
 if(!source||source.roomCode!=='LEM5-RES8'||source.fingerprint!=='c9ef0ad8cbae76ad35293c98cc9e7cf609b2766dad58c97806f6ccb9445ed402')throw Error('Original source unavailable or changed');
 const turns=model.replayFinishedHistory(source.finalState,source.botColor);if(turns.length!==42)throw Error('Incomplete source replay');
 const {engine,game}=loadRuntime();engine.beginExperienceSession('reconstructed-terminal-cold');engine.setExperience([],'server');
 const decisions=turns.map(t=>{engine.plan(t.state,model.liveOptions(t.state));const d=engine.consumeLastDecision();if(!d)throw Error('Missing current-cold decision');d.actor='bot';return d;});
 const descriptor={room_code:source.roomCode,bot_color:source.botColor,decisions};
 const risks=w.attachPreThreatHints(descriptor,decisions.map((d,index)=>({index,...w.archivedStrategicRisk(descriptor,d),
  earlyWindow:index<Math.ceil(decisions.length/2),earlyThreat:w.archivedEarlyStrategicThreat(descriptor,d),capacity:w.productionReviewCapacity(descriptor,d)})));
 const ordered=w.prioritizeStrategicReviewRisks(risks.filter(r=>r.capacity.eligible),4);
 const indexes=ordered.slice(0,4).map(r=>r.index);if(indexes.length!==4)throw Error('Expected four predetermined native-risk cases');
 const cases=indexes.map(index=>{const decision=decisions[index],state=turns[index].state,unique=new Map();
  for(const moves of game.bestMoveSequences(state,state.turn)){const after=applyLegalSequence(game,state,moves);if(!after)throw Error('Invalid native action');const key=afterPositionKey(after);if(!unique.has(key))unique.set(key,{moves,after});}
  const candidates=[...unique.values()];if(candidates.length<2||candidates.length>24||!candidates.some(c=>canonicalMoveKey(c.moves)===canonicalMoveKey(decision.selected.moves)))throw Error('Incomplete admitted native roots');
  return{turnIndex:index,decision,candidates,historicalExecutedMoves:turns[index].executedMoves};});
 const manifest={schema:'long-reconstructed-board-terminal-protocol-v1',preparedAt:new Date().toISOString(),driverSha256:codeHash,
  sourceRoom:source.roomCode,sourceArchiveId:source.archiveId,sourceFingerprint:source.fingerprint,sourceTurns:turns.length,
  sourceVerifiedBy:'native-complete-history-maximum-dice-and-final-board-replay',sourcePolicyImplementationId:source.sourcePolicyImplementationId,
  originalArchivedDecisions:false,productionEvidence:false,policyImplementationId:engine.policyImplementationId,runtimeDigest:w.runtimeDigest(),
  node:process.versions.node,v8:process.versions.v8,selection:{schema:'long-reconstructed-native-risk-selection-v1',outcomesUsed:false,
   maximumExpensiveReviews:4,indexes,risks:ordered.map(({index,tier,signals,capacity})=>({index,tier,signals,capacity}))},
  limits:paired.DEFAULT_ROLLOUT_LIMITS,cases};
 manifest.manifestSha256=sha(stableStringify(manifest));save(file,manifest);return manifest;
}
function read(file){const m=JSON.parse(fs.readFileSync(file)),id=m.manifestSha256;delete m.manifestSha256;
 if(sha(stableStringify(m))!==id||m.driverSha256!==codeHash||m.runtimeDigest!==w.runtimeDigest()||m.policyImplementationId!==EXPECTED_POLICY)throw Error('Protocol or native code changed');m.manifestSha256=id;return m;}
async function run(state){
 if(fs.realpathSync(state)!==state)throw Error('Canonical state path required');
 const protocolFile=path.join(state,'protocol.json');await prepare(protocolFile);const m=read(protocolFile);
 const results=m.cases.map((_,i)=>{const file=path.join(state,`case-${i}.json`);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;});
 while(!fs.existsSync(path.join(state,'pause-admission'))){
  let pending=0;
  for(const [index,c]of m.cases.entries()){
   if(results[index]?.ok&&results[index].coverage?.complete)continue;pending++;
   const runtime=loadRuntime();const result=await paired.generatePairedPolicyOutcomes(c.decision,c.candidates,{
    rolloutLimits:m.limits,trustedOfflineTerminalJournal:{directory:path.join(state,'terminal-journal')},
    terminalJournalBindings:{schema:'long-reconstructed-board-terminal-bindings-v1',protocolSha256:m.manifestSha256,
     sourceArchiveId:m.sourceArchiveId,sourceFingerprint:m.sourceFingerprint,driverSha256:codeHash,
     policyImplementationId:m.policyImplementationId,runtimeDigest:m.runtimeDigest,caseIndex:index,originalArchivedDecision:false},
    nativeCacheAttestation:{runtimeDigest:m.runtimeDigest,policyImplementationId:m.policyImplementationId,
     gameBytesDigest:runtime.gameBytesDigest,runtimeBytesDigest:runtime.runtimeBytesDigest}});
   result.productionEvidence=false;result.sourceRoom=m.sourceRoom;result.turnIndex=c.turnIndex;result.protocolSha256=m.manifestSha256;
   save(path.join(state,`case-${index}.json`),result);results[index]=result;
   console.log(JSON.stringify({at:new Date().toISOString(),room:m.sourceRoom,turn:c.turnIndex+1,ok:result.ok,reason:result.reason,
    coverage:result.coverage,regret:result.regret,regretLcb:result.regretLcb}));
   if(!result.ok&&result.reason!=='rollout-time-limit')throw Error('Nonterminal failure requires investigation: '+result.reason);
  }
  const summary={schema:'long-reconstructed-board-terminal-summary-v1',protocolSha256:m.manifestSha256,sourceRoom:m.sourceRoom,
   productionEvidence:false,complete:results.every(r=>r?.ok&&r.coverage?.complete),cases:results.map((r,i)=>({turn:m.cases[i].turnIndex+1,
    complete:!!r?.ok,coverage:r?.coverage,regret:r?.regret,regretLcb:r?.regretLcb}))};save(path.join(state,'summary.json'),summary);
  if(summary.complete){console.log(JSON.stringify(summary));return;}
  if(!pending)throw Error('Invalid incomplete cursor');
 }
}
if(require.main===module){const state=process.argv[2];if(state!=='/var/lib/online-backgammon-lem-terminal-review-20261123')throw Error('Fixed private state required');run(state).catch(e=>{console.error(e.message);process.exitCode=1});}
