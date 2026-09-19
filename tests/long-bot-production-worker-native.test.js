'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Production requires root-owned immutable executables. This integration is
// run explicitly as the worker UID on the real VPS before activation; an
// ordinary developer/CI checkout is not production authority.
const nativeProductionHost = process.platform === 'linux' && fs.existsSync('/usr/bin/flock')
  && fs.statSync(root).uid === 0;

test('real Linux production wrapper resumes the exact native fixed cohort then completes the original ledger',
  { skip: !nativeProductionHost }, t => {
    const stateDirectory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'long-production-native-'));
    fs.chmodSync(stateDirectory, 0o700);
    fs.writeFileSync(path.join(stateDirectory, 'worker.flock'), '', { mode: 0o600, flag: 'wx' });
    t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
    const code = `
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=${JSON.stringify(root)},directory=${JSON.stringify(stateDirectory)};
const w=require(path.join(root,'scripts/long-bot-causal-worker'));
const {loadRuntime}=require(path.join(root,'scripts/generate-long-bot-shadow-replay'));
const {exactExecute,freezeEmptyExperience}=require(path.join(root,'scripts/train-long-bot-causal-army'));
const runtime=loadRuntime(),state=runtime.game.initialState('long');
Object.assign(state,{phase:'move',turn:'dark',points:{16:{color:'dark',count:1},13:{color:'dark',count:1},5:{color:'white',count:1}},
off:{white:14,dark:13},bar:{white:0,dark:0},dice:[1,2],rolled:[1,2],firstMoveDone:{white:true,dark:true},
headPlayedThisTurn:{white:false,dark:false},turnMoves:[],history:[]});
const experience=freezeEmptyExperience(runtime.engine,'production-native-fixture');
const plan=runtime.engine.plan(state,structuredClone(w.PRODUCTION_POLICY));
const decision=structuredClone(runtime.engine.consumeLastDecision());decision.actor='bot';decision.replayExperience=experience;
const executed=exactExecute(runtime.game,state,plan,decision);
decision.execution={complete:true,fallback:false,substituted:false,selectedMatchesExecuted:true,executedMoves:executed.moves,
after:executed.after,executedActionKey:decision.selected.experience.actionKey,
executed:{moves:executed.moves,after:executed.after,experience:structuredClone(decision.selected.experience)}};
const second=structuredClone(decision);second.id='second-synthetic-original-index';
state.analysis={botMemory:{engineVersion:w.ENGINE_VERSION,replayExperience:experience,
coverage:{complete:true,expectedBotDecisions:2,recordedBotDecisions:2,recoveredBotDecisions:0}}};
const game={id:'fd57bdea-e4f4-488a-a128-cad346ba6ff1',room_code:'SYNTHETIC-ONLY',engine_version:w.ENGINE_VERSION,
difficulty:'hard',bot_color:'dark',winner:'white',decisions:[decision,second],final_state:structuredClone(state)};
assert.equal(w.validateGameEnvelope(game),'');
const source=JSON.stringify(game),fingerprint=crypto.createHash('sha256').update(source).digest('hex');
let progress={schema:w.PROGRESS_SCHEMA,finishedReviews:[],currentDecisionIndex:null,currentTerminalOutcomes:0,
 currentRolloutCheckpoint:null,slices:0,stalledSlices:0};
const calls=[],journalDirectory=path.join(directory,'terminal-journal');
global.fetch=async(url,request)=>{
 const name=url.split('/').at(-1),args=JSON.parse(request.body);calls.push({name,args});
 let response;
 if(name==='claim_long_bot_causal_review_slices')response=[{jobId:1,runtimeDigest:w.runtimeDigest(),policyImplementationId:w.policyImplementationId(),
 archiveFingerprintSource:source,archiveFingerprint:fingerprint,trainingGame:game,progress:structuredClone(progress)}];
 else if(name==='checkpoint_long_bot_causal_review_slice'){
   progress=structuredClone(args.p_progress);w.validateProductionProgress(game,progress);
   response={ok:true,status:progress.finishedReviews.length===2?'complete':'pending',inserted:0};
 }else throw new Error('Unexpected mutation '+name);
 return{ok:true,text:async()=>JSON.stringify(response)};
};
function slotCount(){if(!fs.existsSync(journalDirectory))return 0;let n=0;
 for(const job of fs.readdirSync(journalDirectory))for(const cohort of fs.readdirSync(path.join(journalDirectory,job)))
 if(/^[0-9a-f]{64}$/.test(cohort))n+=fs.readdirSync(path.join(journalDirectory,job,cohort)).filter(x=>x.startsWith('slot-')).length;
 return n;}
(async()=>{
 const now=Date.now,baseline=now();
 // Controlled clock is a fixture ONLY, not measured performance or strength.
 Date.now=()=>baseline+(slotCount()>=2?3000000:0);
 let first;try{first=await w.runClaimedBatch({productionJournalDirectory:journalDirectory,supabaseUrl:'https://fixture.invalid',
 serviceRoleKey:'synthetic-not-a-secret',workerId:'native-fixture'});}finally{Date.now=now;}
 assert.equal(first.completed[0].status,'pending',JSON.stringify(first));
 assert.equal(progress.finishedReviews.length,0);assert.ok(progress.currentTerminalOutcomes>=2);
 assert.equal(calls[1].args.p_result.evidence.length,0);assert.equal(calls[1].args.p_result.reviews[0].reason,'rollout-time-limit');
 const partial=progress.currentTerminalOutcomes;
 const resumed=await w.runClaimedBatch({productionJournalDirectory:journalDirectory,supabaseUrl:'https://fixture.invalid',
 serviceRoleKey:'synthetic-not-a-secret',workerId:'native-fixture'});
 assert.equal(resumed.completed[0].status,'pending',JSON.stringify(resumed));
 assert.equal(progress.finishedReviews.length,1);
 assert.equal(progress.finishedReviews[0].review.rollout.coverage.complete,true);
 assert.equal(progress.finishedReviews[0].review.rollout.terminalJournalObservation.resumedTerminalOutcomes,partial);
 const final=await w.runClaimedBatch({productionJournalDirectory:journalDirectory,supabaseUrl:'https://fixture.invalid',
 serviceRoleKey:'synthetic-not-a-secret',workerId:'native-fixture'});
 assert.equal(final.completed[0].status,'complete',JSON.stringify(final));
 const result=calls.at(-1).args.p_result;assert.equal(result.reviewCoverage.scope,'all-bot-decisions');
 assert.deepEqual(result.reviewCoverage.finishedDecisionIndexes,[0,1]);assert.equal(result.reviews.length,2);
 assert.equal(result.reviewCoverage.completedOutcomeCohorts,2);
 assert.equal(calls.filter(x=>x.name==='complete_long_bot_causal_review_job').length,0);
 assert.equal(calls.filter(x=>x.name==='fail_long_bot_causal_review_job').length,0);
 const jobs=fs.readdirSync(journalDirectory);assert.equal(jobs.length,1);
 for(const cohort of fs.readdirSync(path.join(journalDirectory,jobs[0])))if(/^[0-9a-f]{64}$/.test(cohort)){
  const m=JSON.parse(fs.readFileSync(path.join(journalDirectory,jobs[0],cohort,'manifest.json')));
  assert.equal(m.bindings.schema,'long-server-terminal-journal-bindings-v1');
  assert.equal(m.bindings.authoritativeArchivePayloadText,source);
  assert.equal(m.bindings.authoritativeArchiveFingerprint,fingerprint);
  assert.equal(m.bindings.serverJobId,1);
 }
 console.log(JSON.stringify({fixtureOnly:true,rpcTransport:'mock',nativePolicy:true,partial,resumed:partial,finishedDecisions:2,completeCohorts:2}));
})().catch(error=>{console.error(error);process.exitCode=1});`;
    const result = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '--no-fork',
      path.join(stateDirectory, 'worker.flock'), process.execPath, '-e', code], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const observation = JSON.parse(result.stdout.trim());
    assert.equal(observation.fixtureOnly, true);
    assert.equal(observation.finishedDecisions, 2);
    assert.ok(observation.partial >= 2);
  });
