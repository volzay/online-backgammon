'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const L=require('../scripts/long-bot-training-library'),H=require('../scripts/generate-long-bot-shadow-replay');
const T=require('../scripts/long-bot-board-model-worker');
const fixture=require('./fixtures/long-bot-board-learning-rooms.json');
const game=()=>({room_code:'TEST-ONLY',difficulty:'hard',bot_color:'dark',winner:fixture.lemFinal.winner,final_state:structuredClone(fixture.lemFinal),decisions:[]});
test('library validates complete wins and losses and classifies both players without outcome action labels',()=>{
 const loss=L.classify(game());assert.equal(loss.classificationStatus,'ready');assert.equal(loss.classification.botTurns,42);
 assert.equal(loss.classification.opponentTurns,43);assert.equal(loss.turns.length,85);
 const win=game();win.bot_color=win.winner;const result=L.classify(win);
 assert.equal(result.classificationStatus,'ready');assert.equal(result.classification.botTurns,43);
 assert.ok(result.classification.motifs['five-point-fence']>0);assert.ok(result.classification.phases['bearing-off']>0);
 assert.equal(result.classification.historicalImplementationAttested,false);
 assert.throws(()=>T.replayFinishedHistory(win.final_state,win.bot_color));
});
test('incomplete legacy records remain visible but cannot manufacture learning positions',()=>{
 const g=game();g.final_state.history=[];
 g.decisions=[{stateSnapshotV2:{schema:'long-state-v2'},execution:{complete:false}}];
 const r=L.classify(g);assert.equal(r.classificationStatus,'unusable');assert.equal(r.turns.length,0);
 assert.equal(r.classification.issues[0].reason,'unverified-execution');
 g.final_state.winner='dark';assert.throws(()=>L.classify(g),/source-result-mismatch/);
});
test('independent v2 positions require exact maximum-use moves and executed board',()=>{
 const g=game();g.final_state.history=[];const p=fixture.positions[0],runtime=H.loadRuntime();
 const after=H.applyLegalSequence(runtime.game,p.state,p.executedMoves);
 const d={stateSnapshotV2:{...p.state,schema:'long-state-v2'},execution:{complete:true,selectedMatchesExecuted:true,
  executed:{moves:p.executedMoves,after}}};
 g.decisions=[d];assert.equal(L.classify(g).classificationStatus,'partial');
 d.execution.executed.after=structuredClone(after);d.execution.executed.after.off.dark++;
 assert.equal(L.classify(g).classificationStatus,'unusable');
 d.execution.executed.after=after;d.execution.substituted=true;
 assert.equal(L.classify(g).classificationStatus,'unusable');
 d.execution.substituted=false;d.execution.executed.moves=p.executedMoves.slice(0,1);
 assert.equal(L.classify(g).classificationStatus,'unusable');
});
test('source positions reject invalid totals, dice, flags and mismatched archives',()=>{
 const s={...fixture.positions[0].state,schema:'long-state-v2'};
 assert.doesNotThrow(()=>L.validatePosition(s));
 for(const mutate of [s=>s.off.dark++,s=>s.rolled=[1],s=>delete s.firstMoveDone.dark,s=>s.points[25]={color:'dark',count:1}]){
  const broken=structuredClone(s);mutate(broken);assert.throws(()=>L.validatePosition(broken));
 }
 const g=game();g.final_state.history=[];assert.equal(L.classify(g,{id:'original',room_code:'OTHER',winner:g.winner,final_state:fixture.lemFinal}).classificationStatus,'unusable');
});
