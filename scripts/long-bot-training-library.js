'use strict';
// Model-scoped library. A game result classifies its source; it never labels a
// move as good/bad. Original archives and terminal confidence evidence stay intact.
const H=require('./generate-long-bot-shadow-replay');
const teacher=require('./long-bot-board-model-worker');
const {createHash}=require('node:crypto');
const sha=x=>createHash('sha256').update(x).digest('hex');
const VERSION='long-training-library-v1';
const paths={white:Array.from({length:24},(_,i)=>24-i),dark:[12,11,10,9,8,7,6,5,4,3,2,1,24,23,22,21,20,19,18,17,16,15,14,13]};
function validatePosition(snapshot){
 if(snapshot?.schema!=='long-state-v2'||snapshot.variant!=='long'||snapshot.phase!=='move'||!['white','dark'].includes(snapshot.turn)
  ||!Array.isArray(snapshot.dice)||![2,4].includes(snapshot.dice.length)||!snapshot.dice.every(d=>Number.isInteger(d)&&d>=1&&d<=6)
  ||!Array.isArray(snapshot.rolled)||H.stableStringify(snapshot.rolled)!==H.stableStringify(snapshot.dice)
  ||snapshot.turnMoves?.length!==0)throw Error('invalid-position-envelope');
 if(snapshot.dice.length===4&&!snapshot.dice.every(d=>d===snapshot.dice[0]))throw Error('invalid-double');
 const totals={white:0,dark:0};for(const [point,stack]of Object.entries(snapshot.points||{})){
  if(!/^(?:[1-9]|1[0-9]|2[0-4])$/.test(point)||!['white','dark'].includes(stack?.color)||!Number.isInteger(stack.count)||stack.count<1||stack.count>15)throw Error('invalid-checkers');totals[stack.color]+=stack.count;
 }
 for(const c of ['white','dark'])if(!Number.isInteger(snapshot.off?.[c])||snapshot.off[c]<0||snapshot.off[c]>15||snapshot.bar?.[c]!==0||totals[c]+snapshot.off[c]!==15
  ||typeof snapshot.firstMoveDone?.[c]!=='boolean'||typeof snapshot.headPlayedThisTurn?.[c]!=='boolean')throw Error('invalid-board-total-or-flags');
 return H.stateFromSnapshot(snapshot);
}
function tags(state){
 const color=state.turn,opp=color==='white'?'dark':'white',path=paths[color];let outside=0,head=0,rear=0,home=0,tower=0,run=0,fence=0;
 for(const [p,s]of Object.entries(state.points)){if(s.color===color){const i=path.indexOf(+p);if(i<18)outside+=s.count;else home+=s.count;if(i<6)rear+=s.count;if(i===0)head=s.count;else tower=Math.max(tower,s.count);}}
 for(const p of path){run=state.points[p]?.color===opp?run+1:0;fence=Math.max(fence,run);}
 return { phase:outside===0?'bearing-off':rear>0?'development':'contact', outside,head,rear,home,tower,fence };
}
function describe(state){const m=tags(state);m.motifs=[...(m.head>0?['head-release']:[]),...(m.fence>=4?['threatened-exit']:[]),...(m.fence>=5?['five-point-fence']:[]),...(m.tower>=7?['tower']:[]),...(m.home>0&&m.outside>0?['home-with-laggards']:[]),...(state.off[state.turn]===0&&state.off[state.turn==='white'?'dark':'white']>0?['mars-rescue']:[])];return m;}
function verifyTurn(turn,runtime=H.loadRuntime()){
 const state=validatePosition({...turn.state,schema:'long-state-v2'}),moves=H.canonicalMoves(turn.executedMoves);
 const legal=runtime.game.bestMoveSequences(state,state.turn);
 if(!legal.some(q=>H.canonicalMoveKey(q)===H.canonicalMoveKey(moves))&&(moves.length||legal.some(q=>q.length)))throw Error('illegal-or-nonmaximum-source-turn');
 const after=H.applyLegalSequence(runtime.game,state,moves);
 if(moves.length&&!after)throw Error('source-execution-failed');
 if(turn.executedAfter&&H.afterPositionKey(turn.executedAfter)!==H.afterPositionKey(after||state))throw Error('source-executed-board-mismatch');
 const positionKey=runtime.engine.boardLessonPositionKey(state);
 return {state,executedMoves:moves,actor:turn.actor,positionKey,positionHash:sha(positionKey),...describe(state)};
}
function classify(game,archive=null){
 const runtime=H.loadRuntime(),issues=[],turns=[];let historyVerified=false,sourceArchiveId=null,origin='none';
 if(game.difficulty!=='hard'||game.final_state?.variant!=='long'||!['white','dark'].includes(game.bot_color)||!['white','dark'].includes(game.winner))throw Error('not-hard-long-source');
 const final=game.final_state;
 const outcomeConsistent=final.winner===game.winner&&final.off?.[game.winner]===15;
 if(!outcomeConsistent)issues.push({kind:'source-result',reason:'source-result-mismatch'});
 const candidates=[{state:final,kind:'training-history',archiveId:null}];
 if(archive&&archive.room_code===game.room_code&&archive.final_state?.startedAt===final.startedAt&&final.startedAt!=null
  &&archive.winner===game.winner&&H.afterPositionKey(archive.final_state)===H.afterPositionKey(final))candidates.push({state:archive.final_state,kind:'room-history',archiveId:archive.id});
 for(const source of candidates){if(!outcomeConsistent||!Array.isArray(source.state?.history)||!source.state.history.length)continue;
  try{const verified=teacher.replayFinishedHistory(source.state,game.bot_color,runtime,{allowWins:true,includeOpponent:true}).map(t=>verifyTurn(t,runtime));turns.push(...verified);historyVerified=true;origin=source.kind;sourceArchiveId=source.archiveId;break;}catch(e){issues.push({kind:source.kind,reason:e.message});}
 }
 if(!historyVerified){origin='verified-v2-positions';for(const [index,d]of (game.decisions||[]).entries()){
  if(d.stateSnapshotV2?.schema!=='long-state-v2')continue;
  try{const execution=d.execution;if(execution?.complete!==true||execution.fallback===true||execution.substituted===true||execution.selectedMatchesExecuted!==true
    ||!Array.isArray(execution.executed?.moves)||!execution.executed?.after)throw Error('unverified-execution');
   turns.push({...verifyTurn({state:d.stateSnapshotV2,executedMoves:execution.executed.moves,executedAfter:execution.executed.after,
    actor:d.stateSnapshotV2.turn===game.bot_color?'bot':'opponent'},runtime),ledgerIndex:index});
  }catch(e){issues.push({kind:'v2-position',ledgerIndex:index,reason:e.message});}
 }}
 if(turns.length>600)throw Error('source-turn-capacity');
 const phases={},motifs={};for(const t of turns){phases[t.phase]=(phases[t.phase]||0)+1;for(const tag of t.motifs)motifs[tag]=(motifs[tag]||0)+1;}
 return {classificationStatus:historyVerified?'ready':turns.length?'partial':'unusable',classification:{version:VERSION,origin,historyVerified,outcomeConsistent,
   sourceArchiveId,totalTurns:turns.length,botTurns:turns.filter(t=>t.actor==='bot').length,opponentTurns:turns.filter(t=>t.actor==='opponent').length,
   uniquePositions:new Set(turns.map(t=>t.positionHash)).size,phases,motifs,issues:issues.slice(0,100),reason:turns.length?'':'no-verifiable-history-or-v2-execution',
   historicalImplementationAttested:false},turns};
}
module.exports={VERSION,sha,validatePosition,verifyTurn,describe,classify};
