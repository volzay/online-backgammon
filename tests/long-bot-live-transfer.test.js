'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadRuntime,canonicalMoveKey,stateFromSnapshot}=require('../scripts/generate-long-bot-shadow-replay');
const f=require('./fixtures/long-bot-live-transfer.json');
const {engine}=loadRuntime();
const moveKey=c=>canonicalMoveKey(c.sequence||c.moves);
test('real loss experience transfers to an independent online board only after fresh complete reply analysis',()=>{
 const s=stateFromSnapshot(f.state);engine.beginExperienceSession('transfer-test');engine.setExperience([],'server');
 const cold=engine.rank(s,f.options)[0];const before=engine.experienceSnapshot().fingerprint;
 assert.ok(f.lessons.every(p=>p.positionKey!==engine.boardLessonPositionKey(s)));
 engine.setExperience(f.lessons,'server');assert.equal(engine.experienceSize(),f.lessons.length);
 engine.freezeExperience();const learned=engine.rank(s,f.options)[0];
 assert.notEqual(moveKey(cold),moveKey(learned));assert.equal(learned.features.boardModelLessonTransferred,1);
 const proof=learned.boardModelLesson;assert.equal(proof.sourceRoom,'LEM5-RES8');
 assert.equal(proof.evaluationSource,'live-learned-transfer-comparison-v1');
 assert.equal(proof.diceOutcomes,21);assert.equal(proof.diceWeight,36);
 assert.ok(proof.evaluation.utility>=proof.controlEvaluation.utility+.025);
 assert.ok(proof.evaluation.expectedEquity>=proof.controlEvaluation.expectedEquity+.025);
 assert.ok(proof.evaluation.lowerTailEquity>=proof.controlEvaluation.lowerTailEquity-.06);
 assert.ok(proof.analysisNodesUsed<=63);assert.equal(proof.terminalOutcomeConfirmed,false);
 assert.notEqual(engine.experienceSnapshot().fingerprint,before);
 engine.plan(s,f.options);const d=engine.consumeLastDecision();assert.equal(d.selected.boardModelLesson.transferred,true);
 assert.equal(d.experienceFrozen,true);engine.beginExperienceSession('transfer-reset');engine.setExperience([],'server');
});
test('model compatibility preserves old provenance without allowing old terminal evidence',()=>{
 const old='2eac358adb59616fd96c7fe84fad43ef252d010906d6f6d7c69ac46c92c207b2';
 assert.equal(engine.acceptsBoardModelPolicyImplementationId(old),true);
 assert.equal(engine.acceptsLearningPolicyImplementationId(old),false);
 const previous='7a263bcd3a44b7248b1b369e18dd552f1a5053e4f0772561f13c9a95e56abfa7';
 assert.equal(engine.acceptsBoardModelPolicyImplementationId(previous),true);
 assert.equal(engine.acceptsLearningPolicyImplementationId(previous),false);
 assert.equal(engine.boardModelCompatibility.terminalEvidenceAlias,false);
 engine.setExperience([{...f.lessons[0],policyImplementationId:'0'.repeat(64)}],'server');assert.equal(engine.experienceSize(),0);
});
test('unrelated game phase and a terminal-confirmed correction suppress transfer',()=>{
 const s=stateFromSnapshot(f.state);engine.beginExperienceSession('negative-transfer');engine.setExperience([],'server');
 const cold=engine.rank(s,f.options)[0];
 engine.setExperience(f.lessons.map(p=>({...p,contextKey:p.contextKey.replace(/^[^|]+/,'bearoff')})),'server');
 assert.equal(moveKey(engine.rank(s,f.options)[0]),moveKey(cold));
 const terminal={creditVersion:9,evidenceSchema:'long-server-causal-pattern-v1',trustDomain:'nardu/server-long-bot-causal/v1',
  reviewerVersion:'long-server-causal-review-v1',runtimeDigest:'a'.repeat(64),aggregateId:'b'.repeat(64),
  policyImplementationId:engine.policyImplementationId,contextKey:cold.experience.contextKey,actionKey:f.lessons[0].preferredActionKey,
  samples:1,losses:1,wins:0,lossWeight:1.5,signalWeight:1.5,severeLosses:0,winWeight:0,outcomeUsed:false};
 engine.setExperience([...f.lessons,terminal],'server');
 assert.notEqual(engine.rank(s,f.options)[0].features.boardModelLessonTransferred,1);
 engine.setExperience([],'server');
});
