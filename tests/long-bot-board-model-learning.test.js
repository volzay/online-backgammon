'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reviewTurn,replayFinishedHistory,liveOptions}=require('../scripts/long-bot-board-model-worker');
const {loadRuntime,canonicalMoveKey}=require('../scripts/generate-long-bot-shadow-replay');
const fixture=require('./fixtures/long-bot-board-learning-rooms.json');
const {engine}=loadRuntime();
const source={archiveId:'00000000-0000-0000-0000-000000000001',fingerprint:'1'.repeat(64)};
test('LEM5 history reproduces all 42 bot turns and rejects illegal, truncated and reordered records',()=>{
 assert.equal(replayFinishedHistory(fixture.lemFinal,'dark').length,42);
 const illegal=structuredClone(fixture.lemFinal);illegal.history.find(e=>e.from).from=24;
 assert.throws(()=>replayFinishedHistory(illegal,'dark'));
 const truncated=structuredClone(fixture.lemFinal);truncated.history.pop();
 assert.throws(()=>replayFinishedHistory(truncated,'dark'));
 const wrong=structuredClone(fixture.lemFinal);wrong.off.dark++;
 assert.throws(()=>replayFinishedHistory(wrong,'dark'),/mismatch/);
});
for(const p of fixture.positions)test(`${p.room}: real board model lesson changes a legal native choice and stays frozen`,async()=>{
 const r=await reviewTurn({state:p.state,executedMoves:p.executedMoves},{...source,roomCode:p.room},p.turnIndex);
 assert.equal(r.status,'model-reviewed');const lesson=r.lesson;
 assert.equal(lesson.terminalOutcomeConfirmed,false);assert.equal(lesson.losses,0);
 assert.equal(lesson.diceOutcomes,21);assert.equal(lesson.diceWeight,36);
 assert.ok(lesson.equityGain>=.025);assert.ok(lesson.utilityGain>=.025);
 assert.notEqual(r.coldAction,r.learnedAction);
 assert.equal(engine.validBoardModelLesson({...lesson,terminalOutcomeConfirmed:true}),false);
 assert.equal(engine.validBoardModelLesson({...lesson,utilityGain:.001}),false);
 engine.beginExperienceSession(`cold-${p.room}`);engine.setExperience([],'server');
 const cold=engine.rank(p.state,liveOptions(p.state))[0];const coldFingerprint=engine.experienceSnapshot().fingerprint;
 engine.setExperience([lesson],'server');assert.equal(engine.experienceSize(),1);
 engine.freezeExperience();const frozen=engine.experienceSnapshot();
 assert.notEqual(frozen.fingerprint,coldFingerprint);
 const learned=engine.rank(p.state,liveOptions(p.state))[0];
 assert.equal(learned.features.boardModelLessonApplied,1);
 assert.notEqual(canonicalMoveKey(cold.sequence),canonicalMoveKey(learned.sequence));
 engine.plan(p.state,liveOptions(p.state));const record=engine.consumeLastDecision();
 assert.equal(record.selected.boardModelLesson.aggregateId,lesson.aggregateId);
 assert.equal(record.experienceFrozen,true);
 engine.setExperience([],'server');assert.equal(engine.experienceSnapshot().fingerprint,frozen.fingerprint);
 assert.equal(engine.rank(p.state,liveOptions(p.state))[0].features.boardModelLessonApplied,1);
 engine.beginExperienceSession(`next-${p.room}`);assert.equal(engine.experienceSize(),0);
 engine.setExperience([{...lesson,policyImplementationId:'0'.repeat(64)}],'server');assert.equal(engine.experienceSize(),0);
 engine.setExperience([lesson],'server');const different=structuredClone(p.state);different.dice.reverse();
 if(JSON.stringify(different.dice)!==JSON.stringify(p.state.dice)){
  const next=engine.rank(different,liveOptions(different))[0];
  if(next.features.boardModelLessonApplied===1){
   assert.equal(next.boardModelLesson.transferred,true);
   assert.equal(next.boardModelLesson.evaluationSource,'live-learned-transfer-comparison-v1');
   assert.equal(next.boardModelLesson.diceOutcomes,21);
  }
 }
 engine.setExperience([],'server');
 const terminalPenalty={creditVersion:9,evidenceSchema:'long-server-causal-pattern-v1',
  reviewerVersion:'long-server-causal-review-v1',trustDomain:'nardu/server-long-bot-causal/v1',
  runtimeDigest:'a'.repeat(64),aggregateId:'b'.repeat(64),policyImplementationId:engine.policyImplementationId,
  contextKey:lesson.contextKey,actionKey:lesson.preferredActionKey,samples:1,losses:1,wins:0,
  lossWeight:1.5,signalWeight:1.5,severeLosses:0,winWeight:0,outcomeUsed:false};
 engine.setExperience([lesson,terminalPenalty],'server');
 assert.notEqual(engine.rank(p.state,liveOptions(p.state))[0].features.boardModelLessonApplied,1);
 engine.setExperience([],'server');
});
