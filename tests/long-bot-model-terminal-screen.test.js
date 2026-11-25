'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const H=require('../scripts/generate-long-bot-shadow-replay');
const S=require('../scripts/long-bot-model-terminal-screen');
const {game,engine}=H.loadRuntime();
function fixture(){
 const state=game.initialState('long');
 Object.assign(state,{turn:'white',phase:'move',points:{3:{color:'white',count:1},1:{color:'white',count:1},13:{color:'dark',count:1}},
  off:{white:13,dark:14},dice:[3,1],rolled:[3,1],firstMoveDone:{white:true,dark:true}});
 const win=[{from:3,to:0,die:3},{from:1,to:0,die:1}];
 const lose=[{from:3,to:2,die:1},{from:2,to:0,die:3}];
 return {state,win,lose,tape:[{color:'white',dice:[3,1],moves:win},{color:'dark',dice:[1,2],moves:[{from:13,to:0,die:1}]}],
  source:{fingerprint:'a'.repeat(64),trainingGameId:'synthetic-endgame'},sourceTurnIndex:0,
  id:{policyImplementationId:engine.policyImplementationId,runtimeDigest:'b'.repeat(64)}};
}
test('complete paired screen rejects a legal losing lesson and accepts a winning correction',()=>{
 const f=fixture(),directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'long-screen-')));fs.chmodSync(directory,0o700);
 try{
  const store=S.privateStore(directory);
  const losing=S.runScreen({...f,baselineMoves:f.win,preferredMoves:f.lose,store});
  assert.equal(losing.complete,true);assert.equal(losing.accepted,false);assert.equal(losing.comparison,-1);
  assert.equal(losing.control.ownOff,15);assert.equal(losing.recommended.opponentOff,15);
  assert.equal(losing.sampleCount,1);assert.equal(losing.terminalOutcomeConfirmed,false);
  const winning=S.runScreen({...f,baselineMoves:f.lose,preferredMoves:f.win,store});
  assert.equal(winning.accepted,true);assert.equal(winning.comparison,1);
  assert.equal(winning.tapeHash,losing.tapeHash);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('capacity resumes the same pair and corrupt checkpoints fail closed',()=>{
 const f=fixture(),directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'long-screen-')));fs.chmodSync(directory,0o700);
 try{
  const store=S.privateStore(directory),args={...f,baselineMoves:f.win,preferredMoves:f.lose,store};
  const paused=S.runScreen({...args,maxWorkPlies:0});assert.equal(paused.status,'capacity');
  const reloadedState=structuredClone(f.state);reloadedState.startedAt=Date.now()+1000;
  reloadedState.turnClock.startedAt=Date.now()+2000;
  const finished=S.runScreen({...args,state:reloadedState,maxWorkPlies:1});assert.equal(finished.status,'complete');
  assert.equal(finished.manifestHash,paused.key);assert.equal(finished.accepted,false);
  const file=path.join(directory,paused.key+'.json'),value=JSON.parse(fs.readFileSync(file));
  value.payload.arms.recommended.state.off.dark=14;fs.writeFileSync(file,JSON.stringify(value));
  assert.throws(()=>S.runScreen(args),/checksum changed/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('terminal screen uses a fixed extension and refuses unverified chronological input',()=>{
 assert.deepEqual(S.supplementaryDice('same',10,'white'),S.supplementaryDice('same',10,'white'));
 const f=fixture();assert.equal(S.tapeFromTurns([{state:f.state,sourceTurnIndex:2,executedMoves:[]}]),null);
 assert.equal(S.tapeFromTurns([{state:f.state,sourceTurnIndex:0,executedMoves:f.win}]).length,1);
});
