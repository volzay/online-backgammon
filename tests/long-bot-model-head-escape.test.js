'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('../scripts/generate-long-bot-shadow-replay');
const {liveOptions}=require('../scripts/long-bot-board-model-worker');
const {game,engine}=H.loadRuntime();

// Synthetic contact position: four rear checkers have one useful landing
// station. These are constructed test boards, not a player's archived game.
function contactPosition(color) {
 const state=game.initialState('long');
 Object.assign(state,{turn:color,phase:'move',dice:[4,6],rolled:[4,6],firstMoveDone:{white:true,dark:true}});
 const dark={12:4,8:1,6:2,4:2,3:2,2:2,20:1,17:1};
 const white={11:1,10:1,9:1,7:1,24:5,23:2,22:2,21:2};
 const point=n=>color==='dark'?n:(n+11)%24+1;
 state.points={};
 for(const [side,stacks]of Object.entries({dark,white}))for(const [p,count]of Object.entries(stacks)){
  state.points[point(Number(p))]={color:color==='dark'?side:game.opponentOf(side),count};
 }
 const moves=sequence=>sequence.map(([from,to,die])=>({from:point(from),to:point(to),die}));
 return {state,release:moves([[12,8,4],[2,20,6]]),hold:moves([[6,2,4],[8,2,6]])};
}

for(const color of ['dark','white'])test(`model advice preserves a threatened head release for ${color}`,async()=>{
 const M=await import('../bot-engine/long/metrics.ts');
 const {preservesBoardModelHeadEscape}=await import('../bot-engine/long/engine.ts');
 const {state,release,hold}=contactPosition(color),options=liveOptions(state);
 const released=H.applyLegalSequence(game,state,release),held=H.applyLegalSequence(game,state,hold);
 assert.ok(released&&held,'both complete turns must be legal');
 assert.equal(M.headCheckers(released,color),3);assert.equal(M.headCheckers(held,color),4);
 assert.ok(M.escapeGatewayRisk(held,color)>M.escapeGatewayRisk(released,color));
 assert.equal(preservesBoardModelHeadEscape(state,color,{after:held},{after:released}),false);
 assert.equal(preservesBoardModelHeadEscape(state,color,{after:released},{after:held}),true);

 engine.beginExperienceSession(`head-escape-${color}`);engine.setExperience([],'server');
 const cold=engine.rank(state,options)[0],described=engine.describeSequence(state,hold,options);
 assert.equal(M.headCheckers(cold.after,color),3);
 // A typed heuristic recommendation can claim a good proxy score while
 // worsening the actual exit. Its unconfirmed score cannot waive the guard.
 const lesson={creditVersion:10,evidenceSchema:'long-server-board-model-pattern-v1',
  trustDomain:'nardu/server-long-bot-board-model/v1',reviewerVersion:'long-board-model-review-v1',
  scoreSemantics:'heuristic-turn-equity-v1',outcomeUsed:false,terminalOutcomeConfirmed:false,
  samples:1,losses:0,wins:0,runtimeDigest:'a'.repeat(64),aggregateId:'b'.repeat(64),
  policyImplementationId:engine.policyImplementationId,positionKey:engine.boardLessonPositionKey(state),
  contextKey:cold.experience.contextKey,actionKey:cold.experience.actionKey,
  preferredActionKey:described.experience.actionKey,preferredMoves:hold,
  utilityGain:.1,equityGain:.1,diceOutcomes:21,diceWeight:36,
  baseline:{utility:0,expectedEquity:0,lowerTailEquity:0,selfEvaluation:0,opponentEvaluation:0},
  recommended:{utility:.1,expectedEquity:.1,lowerTailEquity:.1,selfEvaluation:0,opponentEvaluation:0}};
 assert.equal(engine.validBoardModelLesson(lesson),true);
 engine.setExperience([lesson],'server');engine.freezeExperience();
 const warm=engine.rank(state,options)[0];
 assert.equal(H.afterPositionKey(warm.after),H.afterPositionKey(cold.after));
 assert.ok(warm.features.boardModelHeadEscapeVetoes>0);
 assert.notEqual(warm.features.boardModelLessonApplied,1);
 engine.beginExperienceSession(`head-escape-reset-${color}`);engine.setExperience([],'server');
});
