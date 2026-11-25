'use strict';
// A fixed paired regression screen, never a population confidence certificate.
// The planner sees its current roll only; historical future rolls belong to
// this offline teacher, not to the online decision API.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const crypto=require('node:crypto'),zlib=require('node:zlib');
const H=require('./generate-long-bot-shadow-replay');
const ROOT=path.resolve(__dirname,'..');
const VERSION='long-native-terminal-regression-screen-v1';
const BASELINE='dc1402ccf10a0faf97e601335cd081d1b190ec3636f13b35b39f0d0ffb8da3f1';
const BASELINE_FILE='bot-engine/long/training/terminal-screen-baseline-v1.json';
const sha=x=>crypto.createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:H.stableStringify(x)).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x));
let runtimes;
function runtime(engineBytes){
 const memory=new Map(),storage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)};
 const math=Object.create(Math);math.random=()=>{throw Error('Unseeded terminal-screen choice');};
 const box={window:{},Math:math,Date,JSON,URL,setTimeout,clearTimeout,sessionStorage:storage,console:{log(){},warn(){},error(){}}};
 box.window.window=box.window;box.window.sessionStorage=storage;vm.createContext(box);
 vm.runInContext(fs.readFileSync(path.join(ROOT,'game.js'),'utf8'),box);
 vm.runInContext(engineBytes.toString('utf8'),box);
 return {game:box.window.NarduGame,engine:box.window.NarduLongBotEngine};
}
function loadRuntimes(){
 if(runtimes)return runtimes;
 const artifact=JSON.parse(fs.readFileSync(path.join(ROOT,BASELINE_FILE)));
 if(artifact.schema!=='long-terminal-screen-baseline-v1'||artifact.bundleSha256!==BASELINE)throw Error('Terminal-screen baseline identity invalid');
 const bytes=zlib.gunzipSync(Buffer.from(artifact.data,'base64'),{maxOutputLength:2000000});
 if(sha(bytes)!==BASELINE||bytes.length!==artifact.uncompressedBytes)throw Error('Terminal-screen baseline bytes changed');
 const current=runtime(fs.readFileSync(path.join(ROOT,'long-bot-engine.js'))),opponent=runtime(bytes);
 if(opponent.engine.policyImplementationId!==artifact.policyImplementationId)throw Error('Terminal-screen baseline policy changed');
 return runtimes={current,opponent};
}
function privateStore(directory,assertHeld=()=>{}){
 if(!path.isAbsolute(directory)||path.resolve(directory)!==directory)throw Error('Terminal-screen directory invalid');
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const check=()=>{assertHeld();const s=fs.lstatSync(directory);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700||fs.realpathSync(directory)!==directory)throw Error('Terminal-screen directory drift');};
 check();
 return {
  read(key){check();const file=path.join(directory,key+'.json');if(!fs.existsSync(file))return null;
   const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size>500000)throw Error('Terminal-screen checkpoint invalid');
   const envelope=JSON.parse(fs.readFileSync(file,'utf8'));
   if(envelope.sha256!==sha(envelope.payload))throw Error('Terminal-screen checkpoint checksum changed');
   return envelope.payload;
  },
  write(key,value){check();const file=path.join(directory,key+'.json'),temporary=file+'.'+crypto.randomBytes(8).toString('hex');
   const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({payload:value,sha256:sha(value)}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   fs.renameSync(temporary,file);const d=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}check();
  },
 };
}
function tapeFromTurns(turns){
 if(!Array.isArray(turns)||!turns.length||turns.length>600)return null;
 const sorted=[...turns].sort((a,b)=>a.sourceTurnIndex-b.sourceTurnIndex);
 if(sorted.some((t,i)=>t.sourceTurnIndex!==i))return null;
 return sorted.map(t=>({color:t.state.turn,dice:clone(t.state.dice),moves:H.canonicalMoves(t.executedMoves)}));
}
function normalizeTape(tape){
 if(!Array.isArray(tape)||!tape.length||tape.length>600)throw Error('Verified terminal-screen tape required');
 return tape.map((t,i)=>{
  if(!['white','dark'].includes(t.color)||(i&&t.color===tape[i-1].color)||!Array.isArray(t.dice)
   ||![2,4].includes(t.dice.length)||t.dice.some(d=>!Number.isInteger(d)||d<1||d>6)||!Array.isArray(t.moves)||t.moves.length>4)throw Error('Terminal-screen tape invalid');
  return {color:t.color,dice:[...t.dice],moves:H.canonicalMoves(t.moves)};
 });
}
function supplementaryDice(seed,index,color){
 const values=[];let block=0;
 while(values.length<2){const bytes=crypto.createHash('sha256').update(`${VERSION}\0${seed}\0${index}\0${color}\0${block++}`).digest();
  for(const v of bytes){if(v<252)values.push(v%6+1);if(values.length===2)break;}}
 return values[0]===values[1]?[values[0],values[0],values[0],values[0]]:values;
}
function apply(game,state,moves){
 const after=clone(state);
 for(const move of moves){const to=game.moveTo(after.turn,Number(move.from),Number(move.die),after);
  if(Number.isInteger(move.to)&&move.to!==to)return null;
  if(!game.applyMove(after,Number(move.from),Number(move.die),{autoEnd:false}))return null;
  if(after.winner)break;
 }
 if(!after.winner&&game.hasAnyMoves(after))return null;
 if(!after.winner)game.endTurn(after);
 after.history=[];return after;
}
function plan(rt,state){
 rt.engine.beginExperienceSession('terminal-screen-cold');rt.engine.setExperience([],'server');rt.engine.freezeExperience();
 const weights={opponentHeadFreedom:48000,headLandingExposure:62000,headRelease:9800,foothold:4300,homeEntry:145000,rushPenalty:12500,trapRisk:62000,escapeGatewayRisk:800000,distribution:780};
 const options={strategyProfile:'v26',weights,...(state.dice.length===4?{maxCandidates:16,initialSequenceLimit:16,maxTacticalCandidates:2,analysisNodeBudget:58}:{maxCandidates:64,analysisNodeBudget:480})};
 const after=apply(rt.game,state,rt.engine.plan(state,options));if(!after)throw Error('Terminal-screen native policy incomplete');return after;
}
function terminalResult(state,color,plies,traceHash){
 if(!state.winner||state.off[state.winner]!==15)throw Error('Complete native terminal result required');
 const won=state.winner===color,severity=state.resultType==='koks'?3:state.resultType==='mars'?2:1;
 const enemy=color==='white'?'dark':'white';
 return {winner:state.winner,resultType:state.resultType||'normal',ownOff:state.off[color],opponentOff:state.off[enemy],plies,traceHash,
  value:[won?1:0,won?severity:-severity,state.off[color],-state.off[enemy]]};
}
function compareValues(a,b){for(let i=0;i<a.length;i++){if(a[i]!==b[i])return Math.sign(a[i]-b[i]);}return 0;}
function runScreen({state,baselineMoves,preferredMoves,sourceTurnIndex,tape,source,id,store,maxElapsedMs=60000,maxFuturePlies=512,maxWorkPlies=Infinity}){
 // Native normalization may stamp startedAt while the short teacher searches.
 // Process-local clocks and presentation metadata cannot identify a cohort.
 state=H.stateFromSnapshot(state);
 const started=Date.now(),{current,opponent}=loadRuntimes();tape=normalizeTape(tape);
 if(id.policyImplementationId!==current.engine.policyImplementationId||!Number.isInteger(sourceTurnIndex)||sourceTurnIndex<0
  ||sourceTurnIndex>=tape.length||tape[sourceTurnIndex].color!==state.turn
  ||JSON.stringify(tape[sourceTurnIndex].dice)!==JSON.stringify(state.dice))throw Error('Terminal-screen root identity invalid');
 const manifest={schema:VERSION,policyImplementationId:id.policyImplementationId,runtimeDigest:id.runtimeDigest,
  fingerprint:source.fingerprint,gameId:source.trainingGameId,sourceTurnIndex,color:state.turn,
  state:JSON.parse(H.stableStringify(state)),baselineMoves:H.canonicalMoves(baselineMoves),preferredMoves:H.canonicalMoves(preferredMoves),
  tapeHash:sha(tape),baselineBundleSha256:BASELINE};
 // Future dice never depend on the selected action or on a computed outcome.
 const seed=sha([VERSION,source.fingerprint,sourceTurnIndex,manifest.tapeHash]);
 const key=sha(manifest);let saved=store.read(key);
 if(saved&&(saved.manifestHash!==key||sha(saved.manifest)!==key))throw Error('Terminal-screen manifest drift');
 if(!saved){saved={manifestHash:key,manifest,arms:{}};
  for(const [name,moves]of Object.entries({control:baselineMoves,recommended:preferredMoves})){
   const after=apply(current.game,state,moves);if(!after)throw Error('Terminal-screen root action illegal');
   saved.arms[name]={state:after,next:sourceTurnIndex+1,plies:1,trace:sha([key,name,H.afterPositionKey(after)])};
  }store.write(key,saved);
 }
 let worked=0;
 for(const name of ['control','recommended']){
  const arm=saved.arms[name];
  while(!arm.state.winner){
   if(arm.plies>=maxFuturePlies||worked>=maxWorkPlies||Date.now()-started>=maxElapsedMs){store.write(key,saved);return {status:'capacity',key,completedArms:Object.values(saved.arms).filter(a=>a.state.winner).length};}
   const color=arm.state.turn,entry=tape[arm.next];
   if(entry&&entry.color!==color)throw Error('Terminal-screen turn stream drift');
   const dice=entry?.dice||supplementaryDice(seed,arm.next,color);current.game.applyRoll(arm.state,dice);
   let after=null;
   if(color!==state.turn&&entry)after=apply(current.game,arm.state,entry.moves);
   if(!after)after=plan(color===state.turn?current:opponent,arm.state);
   arm.state=after;arm.next++;arm.plies++;worked++;
   arm.trace=sha([arm.trace,color,dice,H.afterPositionKey(after)]);store.write(key,saved);
  }
 }
 const control=terminalResult(saved.arms.control.state,state.turn,saved.arms.control.plies,saved.arms.control.trace);
 const recommended=terminalResult(saved.arms.recommended.state,state.turn,saved.arms.recommended.plies,saved.arms.recommended.trace);
 const comparison=compareValues(recommended.value,control.value);
 const result={schema:VERSION,complete:true,accepted:comparison>0,comparison,sampleCount:1,terminalOutcomeConfirmed:false,
  policyImplementationId:id.policyImplementationId,runtimeDigest:id.runtimeDigest,sourceFingerprint:source.fingerprint,
  sourceTurnIndex,color:state.turn,pairing:'archived-tape-and-fixed-extension-v1',sameFutureDice:true,tapeHash:manifest.tapeHash,
  manifestHash:key,baselineOpponentPolicyImplementationId:opponent.engine.policyImplementationId,control,recommended};
 saved.result=result;store.write(key,saved);return {status:'complete',...result};
}
module.exports={VERSION,BASELINE_FILE,privateStore,tapeFromTurns,runScreen,compareValues,supplementaryDice};
