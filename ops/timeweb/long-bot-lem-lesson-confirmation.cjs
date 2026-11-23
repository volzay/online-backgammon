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
const confidencePath=path.join(__dirname,'long-bot-paired-exact-confidence.js');
const confidence=require(confidencePath),confidenceHash=sha(fs.readFileSync(confidencePath));
function save(file,value){const temporary=file+'.next';fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,file);}
async function prepare(file){
 if(fs.existsSync(file))return read(file);
 const identity=model.identity({production:true});if(identity.policyImplementationId!==EXPECTED_POLICY)throw Error('Unexpected current cold policy');
 const source=await w.supabaseRpc(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,
  'next_long_bot_board_review',{p_policy:identity.policyImplementationId,p_runtime:identity.runtimeDigest,p_rooms:['LEM5-RES8']});
 if(!source||source.roomCode!=='LEM5-RES8'||source.fingerprint!=='c9ef0ad8cbae76ad35293c98cc9e7cf609b2766dad58c97806f6ccb9445ed402')throw Error('Original source unavailable or changed');
 const turns=model.replayFinishedHistory(source.finalState,source.botColor);if(turns.length!==42)throw Error('Incomplete source replay');
 const {engine,game}=loadRuntime();engine.beginExperienceSession('reconstructed-terminal-cold');engine.setExperience([],'server');
 const lessons=(await w.supabaseRpc(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,
  'get_long_bot_experience_patterns',{p_player_name:null})).filter(p=>p.creditVersion===10&&p.sourceRoom==='LEM5-RES8'
   &&p.sourceArchiveId===source.archiveId&&p.sourceFingerprint===source.fingerprint
   &&p.policyImplementationId==='2eac358adb59616fd96c7fe84fad43ef252d010906d6f6d7c69ac46c92c207b2'
   &&p.runtimeDigest==='5a0d17b50bcc9b4900ccd1e7c133f5f85fe23676b010e46f985cc799f5369146')
  .sort((a,b)=>a.turnIndex-b.turnIndex);
 if(lessons.length!==7||new Set(lessons.map(p=>p.turnIndex)).size!==7)throw Error('Expected all seven original LEM5 model proposals');
 const cases=lessons.map(lesson=>{const index=lesson.turnIndex,state=turns[index].state;
  engine.plan(state,model.liveOptions(state));const decision=engine.consumeLastDecision();
  if(!decision||canonicalMoveKey(decision.selected.moves)!==canonicalMoveKey(lesson.baselineMoves))throw Error('Current cold selection differs from proposal baseline');
  const legal=game.bestMoveSequences(state,state.turn);
  const candidates=[decision.selected.moves,lesson.preferredMoves].map(moves=>{
   if(!legal.some(q=>canonicalMoveKey(q)===canonicalMoveKey(moves)))throw Error('Proposal is not native maximum-use legal action');
   const after=applyLegalSequence(game,state,moves);if(!after)throw Error('Invalid native action');return{moves,after};});
  if(afterPositionKey(candidates[0])===afterPositionKey(candidates[1]))throw Error('Identical proposed and control result');
  return{turnIndex:index,decision,candidates,modelAggregateId:lesson.aggregateId,historicalExecutedMoves:turns[index].executedMoves};});
 const manifest={schema:'long-lem-model-terminal-confirmation-protocol-v1',preparedAt:new Date().toISOString(),driverSha256:codeHash,
  sourceRoom:source.roomCode,sourceArchiveId:source.archiveId,sourceFingerprint:source.fingerprint,sourceTurns:turns.length,
  sourceVerifiedBy:'native-complete-history-maximum-dice-and-final-board-replay',sourcePolicyImplementationId:source.sourcePolicyImplementationId,
  originalArchivedDecisions:false,productionEvidence:false,confidenceCodeSha256:confidenceHash,
  primaryConfidence:{method:confidence.METHOD,declaredPairs:32,familywiseAlpha:0.05,comparisonCount:7,perCaseAlpha:0.05/7,
   minimumEffectLowerBound:0.08,optionalStopping:false,selectionUsingTerminalOutcomes:false},policyImplementationId:engine.policyImplementationId,runtimeDigest:w.runtimeDigest(),
  node:process.versions.node,v8:process.versions.v8,selection:{schema:'long-prespecified-model-proposal-terminal-confirmation-v1',
   outcomesUsed:false,scope:'all-seven-preexisting-LEM5-model-proposals',legalSetScope:'two prespecified legal actions per proposal; not every alternative board',
   indexes:cases.map(c=>c.turnIndex),modelAggregateIds:lessons.map(p=>p.aggregateId)},
  limits:{...paired.DEFAULT_ROLLOUT_LIMITS,maxUniquePositions:2,familywiseAlpha:0.05/7},cases};
 manifest.manifestSha256=sha(stableStringify(manifest));save(file,manifest);return manifest;
}
function read(file){const m=JSON.parse(fs.readFileSync(file)),id=m.manifestSha256;delete m.manifestSha256;
 if(sha(stableStringify(m))!==id||m.driverSha256!==codeHash||m.confidenceCodeSha256!==confidenceHash||m.runtimeDigest!==w.runtimeDigest()||m.policyImplementationId!==EXPECTED_POLICY)throw Error('Protocol or native code changed');m.manifestSha256=id;return m;}
function pairedConfidence(m,c,result,state,index){
 const directory=path.join(state,'terminal-journal');
 const manifestId=result.terminalJournalObservation?.manifestId;
 if(!/^[0-9a-f]{64}$/.test(manifestId||''))throw Error('Missing completed native journal');
 const manifest=JSON.parse(fs.readFileSync(path.join(directory,manifestId,'manifest.json')));
 if(manifest.bindings.protocolSha256!==m.manifestSha256||manifest.bindings.caseIndex!==index
  ||manifest.bindings.driverSha256!==codeHash||manifest.bindings.sourceFingerprint!==m.sourceFingerprint
  ||manifest.sampleCount!==32||manifest.candidateIds.length!==2
  ||manifest.bindings.orderedStateCanonical!==stableStringify(c.decision.stateSnapshotV2))throw Error('Native cohort/protocol mismatch');
 const ids=c.candidates.map(candidate=>sha(afterPositionKey(candidate)));
 if(ids.some(id=>!manifest.candidateIds.includes(id)))throw Error('Native admitted action mismatch');
 const {createTerminalJournal}=require(APP+'/scripts/long-bot-terminal-journal');
 const journal=createTerminalJournal({directory,manifest});
 const values=[[],[]],counts={sweepWins:0,sweepLosses:0,splitPairs:0};
 try{
  if(!journal.observation().complete)throw Error('Partial pairs cannot produce confidence');
  for(let sample=0;sample<32;sample++){
   const pair=ids.map((id,side)=>{const slot=journal.lookup(sample,id,manifest.seedsBySample[sample]);
    if(!slot||!slot.complete||!['white','dark'].includes(slot.winner))throw Error('Missing native terminal endpoint');
    const won=Number(slot.winner===manifest.botColor);values[side].push(won);return won;});
   const difference=pair[1]-pair[0];counts[difference>0?'sweepWins':difference<0?'sweepLosses':'splitPairs']++;
  }
 }finally{journal.close();}
 for(let side=0;side<2;side++){
  const row=result.candidates.find(row=>afterPositionKey(row)===afterPositionKey(c.candidates[side]));
  if(!row||row.rolloutWins!==values[side].reduce((n,v)=>n+v,0)||row.outcomeFingerprint!==sha(values[side].join('')))throw Error('Published native counts differ from authenticated slots');
 }
 const bound=confidence.pairedMeanLowerBound(counts,{declaredPairs:32,alpha:m.primaryConfidence.perCaseAlpha});
 const effectLower=2*bound.lower-1;
 return{...bound,lowerWinProbabilityGain:effectLower,minimumRequiredGain:0.08,qualifies:effectLower>0.08,
  complete:true,independentlyVerifiedScope:'fixed source model proposal; all 32 authenticated paired terminal endpoints',productionEvidence:false};
}
async function run(state){
 if(fs.realpathSync(state)!==state)throw Error('Canonical state path required');
 const protocolFile=path.join(state,'protocol.json');await prepare(protocolFile);const m=read(protocolFile);
 const results=m.cases.map((_,i)=>{const file=path.join(state,`case-${i}.json`);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;});
 while(!fs.existsSync(path.join(state,'pause-admission'))){
  let pending=0;
  for(const [index,c]of m.cases.entries()){
   if(results[index]?.ok&&results[index].coverage?.complete&&results[index].primaryPairedConfidence?.complete)continue;pending++;
   const runtime=loadRuntime();const result=await paired.generatePairedPolicyOutcomes(c.decision,c.candidates,{
    rolloutLimits:m.limits,trustedOfflineTerminalJournal:{directory:path.join(state,'terminal-journal')},
    terminalJournalBindings:{schema:'long-reconstructed-board-terminal-bindings-v1',protocolSha256:m.manifestSha256,
     sourceArchiveId:m.sourceArchiveId,sourceFingerprint:m.sourceFingerprint,driverSha256:codeHash,
     policyImplementationId:m.policyImplementationId,runtimeDigest:m.runtimeDigest,caseIndex:index,originalArchivedDecision:false},
    nativeCacheAttestation:{runtimeDigest:m.runtimeDigest,policyImplementationId:m.policyImplementationId,
     gameBytesDigest:runtime.gameBytesDigest,runtimeBytesDigest:runtime.runtimeBytesDigest}});
   if(result.ok&&result.coverage?.complete)result.primaryPairedConfidence=pairedConfidence(m,c,result,state,index);
   result.productionEvidence=false;result.sourceRoom=m.sourceRoom;result.turnIndex=c.turnIndex;result.protocolSha256=m.manifestSha256;
   save(path.join(state,`case-${index}.json`),result);results[index]=result;
   console.log(JSON.stringify({at:new Date().toISOString(),room:m.sourceRoom,turn:c.turnIndex+1,ok:result.ok,reason:result.reason,
    coverage:result.coverage,regret:result.regret,regretLcb:result.regretLcb}));
   if(!result.ok&&result.reason!=='rollout-time-limit')throw Error('Nonterminal failure requires investigation: '+result.reason);
  }
  const summary={schema:'long-lem-model-terminal-confirmation-summary-v1',protocolSha256:m.manifestSha256,sourceRoom:m.sourceRoom,
   productionEvidence:false,complete:results.every(r=>r?.ok&&r.coverage?.complete&&r.primaryPairedConfidence?.complete),cases:results.map((r,i)=>({turn:m.cases[i].turnIndex+1,
    complete:!!r?.ok,coverage:r?.coverage,regret:r?.regret,regretLcb:r?.regretLcb,primaryPairedConfidence:r?.primaryPairedConfidence}))};save(path.join(state,'summary.json'),summary);
  if(summary.complete){console.log(JSON.stringify(summary));return;}
  if(!pending)throw Error('Invalid incomplete cursor');
 }
}
if(require.main===module){const state=process.argv[2];if(state!=='/var/lib/online-backgammon-lem-lesson-confirmation-20261123')throw Error('Fixed private state required');run(state).catch(e=>{console.error(e.message);process.exitCode=1});}
