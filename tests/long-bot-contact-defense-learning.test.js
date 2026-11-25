'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('../scripts/generate-long-bot-shadow-replay');
const {liveOptions}=require('../scripts/long-bot-board-model-worker');
const {game,engine}=H.loadRuntime();

// Independently constructed boards; no private room positions are published.
function position(color,dark,white,dice){
 const s=game.initialState('long'),point=n=>color==='dark'?n:(n+11)%24+1;
 Object.assign(s,{turn:color,phase:'move',dice,rolled:[...dice],firstMoveDone:{white:true,dark:true},points:{}});
 for(const [side,stacks]of Object.entries({dark,white}))for(const [p,count]of Object.entries(stacks)){
  s.points[point(+p)]={color:color==='dark'?side:game.opponentOf(side),count};
 }
 return {state:s,moves:seq=>seq.map(([from,to,die])=>({from:point(from),to:point(to),die}))};
}

for(const color of ['dark','white']){
 test(`last head checker remains a useful defensive anchor for ${color}`,async()=>{
  const M=await import('../bot-engine/long/metrics.ts');
  const p=position(color,{12:1,11:2,10:3,9:3,5:1,20:1,17:2,15:2},
   {24:2,18:2,16:2,14:2,13:1,8:2,7:2,6:2},[1,4]);
  const release=p.moves([[12,11,1],[9,5,4]]);
  assert.ok(H.applyLegalSequence(game,p.state,release),'releasing the head is also legal');
  assert.ok(M.contactDefenseProfile(p.state,color).headAnchorValue>0);
  engine.beginExperienceSession(`last-anchor-${color}`);engine.setExperience([],'server');
  const chosen=engine.rank(p.state,liveOptions(p.state))[0];
  assert.equal(M.headCheckers(chosen.after,color),1);
  assert.equal(chosen.sequence.length,2,'retention still consumes both required dice');
  assert.equal(M.defensiveLearningContext(p.state,color),M.defensiveLearningContext(
   position(game.opponentOf(color),{12:1,11:2,10:3,9:3,5:1,20:1,17:2,15:2},
    {24:2,18:2,16:2,14:2,13:1,8:2,7:2,6:2},[1,4]).state,game.opponentOf(color)));
 });
 test(`unconfirmed memory cannot sacrifice the opposing-head bridge for home progress for ${color}`,async()=>{
  const M=await import('../bot-engine/long/metrics.ts');
  const {preservesContactDefense}=await import('../bot-engine/long/engine.ts');
  const p=position(color,{12:11,9:1,1:1,22:1,18:1},{24:8,23:2,21:2,19:1,16:1,14:1},[3,4]);
  engine.beginExperienceSession(`bridge-${color}`);engine.setExperience([],'server');
  const cold=engine.rank(p.state,liveOptions(p.state))[0];
  const moves=p.moves([[22,18,4],[18,15,3]]),after=H.applyLegalSequence(game,p.state,moves);
  assert.ok(after);assert.ok(M.contactDefenseProfile(after,color).unsupportedHomeDebt
   >M.contactDefenseProfile(cold.after,color).unsupportedHomeDebt);
  assert.equal(preservesContactDefense(p.state,color,{after},cold),false);
  const described=engine.describeSequence(p.state,moves,liveOptions(p.state));
  const lesson={creditVersion:10,evidenceSchema:'long-server-board-model-pattern-v1',
   trustDomain:'nardu/server-long-bot-board-model/v1',reviewerVersion:'long-board-model-review-v1',
   scoreSemantics:'heuristic-turn-equity-v1',outcomeUsed:false,terminalOutcomeConfirmed:false,
   samples:1,losses:0,wins:0,runtimeDigest:'a'.repeat(64),aggregateId:'b'.repeat(64),
   policyImplementationId:engine.policyImplementationId,positionKey:engine.boardLessonPositionKey(p.state),
   contextKey:cold.experience.contextKey,actionKey:cold.experience.actionKey,
   preferredActionKey:described.experience.actionKey,preferredMoves:moves,
   utilityGain:.1,equityGain:.1,diceOutcomes:21,diceWeight:36,
   baseline:{utility:0,expectedEquity:0,lowerTailEquity:0,selfEvaluation:0,opponentEvaluation:0},
   recommended:{utility:.1,expectedEquity:.1,lowerTailEquity:.1,selfEvaluation:0,opponentEvaluation:0}};
  assert.equal(engine.validBoardModelLesson(lesson),true);
  engine.setExperience([lesson],'server');engine.freezeExperience();
  const warm=engine.rank(p.state,liveOptions(p.state))[0];
  assert.equal(H.afterPositionKey(warm.after),H.afterPositionKey(cold.after));
  assert.notEqual(warm.features.boardModelLessonApplied,1);
  engine.beginExperienceSession(`bridge-reset-${color}`);engine.setExperience([],'server');
 });
}

test('a last head checker still advances when it is the only rear checker',async()=>{
 const M=await import('../bot-engine/long/metrics.ts');
 const s=game.initialState('long');Object.assign(s,{turn:'dark',phase:'move',points:{12:{color:'dark',count:1},1:{color:'white',count:1}},off:{dark:14,white:14},dice:[1,4],rolled:[1,4],firstMoveDone:{dark:true,white:true}});
 assert.equal(M.contactDefenseProfile(s,'dark').headAnchorValue,0);
 engine.beginExperienceSession('clear-last-head');engine.setExperience([],'server');
 const result=engine.rank(s,liveOptions(s))[0];assert.equal(M.headCheckers(result.after,'dark'),0);
 assert.equal(result.sequence.length,2);
});
