'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadRuntime,canonicalMoveKey,stateFromSnapshot}=require('../scripts/generate-long-bot-shadow-replay');
const f=require('./fixtures/long-bot-live-transfer.json');
const {engine}=loadRuntime();
const moveKey=c=>canonicalMoveKey(c.sequence||c.moves);
// Synthetic RPC admission stubs isolate client routing and fresh scoring.
// They are not computed terminal receipts or statistical certificates; the
// native terminal-screen and SQL suites exercise admission independently.
const screenedLessons=f.lessons.map(p=>({...p,screening:{
 schema:'long-native-terminal-regression-screen-v1',complete:true,accepted:true,
 comparison:1,sampleCount:1,terminalOutcomeConfirmed:false,
 policyImplementationId:p.policyImplementationId,runtimeDigest:p.runtimeDigest,
 sourceFingerprint:p.sourceFingerprint,
}}));
test('short-horizon transfer is rejected when the independent board fails recovery safety',()=>{
 const s=stateFromSnapshot(f.state);engine.beginExperienceSession('transfer-test');engine.setExperience([],'server');
 const cold=engine.rank(s,f.options)[0];const before=engine.experienceSnapshot().fingerprint;
 assert.ok(f.lessons.every(p=>p.positionKey!==engine.boardLessonPositionKey(s)));
 engine.setExperience(screenedLessons,'server');assert.equal(engine.experienceSize(),f.lessons.length);
 engine.freezeExperience();const learned=engine.rank(s,f.options)[0];
 assert.equal(moveKey(cold),moveKey(learned));
 assert.notEqual(learned.features.boardModelLessonTransferred,1);
 assert.ok(learned.features.boardModelDeepSafetyVetoes>0);
 assert.equal(learned.tactical.plies,4);
 assert.notEqual(engine.experienceSnapshot().fingerprint,before);
 engine.plan(s,f.options);const d=engine.consumeLastDecision();
 assert.notEqual(d.selected.features.boardModelLessonTransferred,1);
 assert.ok(d.selected.features.boardModelDeepSafetyVetoes>0);
 assert.equal(d.experienceFrozen,true);engine.beginExperienceSession('transfer-reset');engine.setExperience([],'server');
});
test('unreviewed legacy advice cannot authorize transfer to a new board',()=>{
 const s=stateFromSnapshot(f.state);engine.beginExperienceSession('unreviewed-transfer');engine.setExperience([],'server');
 const cold=engine.rank(s,f.options)[0];engine.setExperience(f.lessons,'server');
 const unchanged=engine.rank(s,f.options)[0];assert.equal(moveKey(unchanged),moveKey(cold));
 assert.notEqual(unchanged.features.boardModelLessonTransferred,1);
 engine.beginExperienceSession('unreviewed-reset');engine.setExperience([],'server');
});
test('model compatibility preserves old provenance without allowing old terminal evidence',()=>{
 const old='2eac358adb59616fd96c7fe84fad43ef252d010906d6f6d7c69ac46c92c207b2';
 assert.equal(engine.acceptsBoardModelPolicyImplementationId(old),true);
 assert.equal(engine.acceptsLearningPolicyImplementationId(old),false);
 const previous='7a263bcd3a44b7248b1b369e18dd552f1a5053e4f0772561f13c9a95e56abfa7';
 assert.equal(engine.acceptsBoardModelPolicyImplementationId(previous),true);
 assert.equal(engine.acceptsLearningPolicyImplementationId(previous),false);
 const preceding='db212e88d758f309b3ac3027c857acc55e8a415d1cdf4da3b5d753eea82be10b';
 assert.equal(engine.acceptsBoardModelPolicyImplementationId(preceding),true);
 assert.equal(engine.acceptsLearningPolicyImplementationId(preceding),false);
 const legalReplies='9417fd02f1f6957e878c0376aa00dbf91d2c6e3065269d27a3b2846b52e3ff13';
 assert.equal(engine.acceptsBoardModelPolicyImplementationId(legalReplies),true);
 assert.equal(engine.acceptsLearningPolicyImplementationId(legalReplies),false);
 assert.equal(engine.boardModelCompatibility.terminalEvidenceAlias,false);
 engine.setExperience([{...f.lessons[0],policyImplementationId:'0'.repeat(64)}],'server');assert.equal(engine.experienceSize(),0);
});
test('unrelated game phase and a terminal-confirmed correction suppress transfer',()=>{
 const s=stateFromSnapshot(f.state);engine.beginExperienceSession('negative-transfer');engine.setExperience([],'server');
 const cold=engine.rank(s,f.options)[0];
 engine.setExperience(screenedLessons.map(p=>({...p,contextKey:p.contextKey.replace(/^[^|]+/,'bearoff')})),'server');
 assert.equal(moveKey(engine.rank(s,f.options)[0]),moveKey(cold));
 const terminal={creditVersion:9,evidenceSchema:'long-server-causal-pattern-v1',trustDomain:'nardu/server-long-bot-causal/v1',
  reviewerVersion:'long-server-causal-review-v1',runtimeDigest:'a'.repeat(64),aggregateId:'b'.repeat(64),
  policyImplementationId:engine.policyImplementationId,contextKey:cold.experience.contextKey,actionKey:f.lessons[0].preferredActionKey,
  samples:1,losses:1,wins:0,lossWeight:1.5,signalWeight:1.5,severeLosses:0,winWeight:0,outcomeUsed:false};
 engine.setExperience([...screenedLessons,terminal],'server');
 assert.notEqual(engine.rank(s,f.options)[0].features.boardModelLessonTransferred,1);
 engine.setExperience([],'server');
});
