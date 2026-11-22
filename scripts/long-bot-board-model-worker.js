#!/usr/bin/env node
'use strict';
// Deterministic, model-scoped self-improvement. These are NOT terminal outcome
// confidence certificates and never enter long_bot_causal_evidence.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { loadRuntime, stateFromSnapshot, afterPositionKey, canonicalMoveKey,
  canonicalMoves, applyLegalSequence, stableStringify } = require('./generate-long-bot-shadow-replay');
const { runtimeClosureFiles, supabaseRpc } = require('./long-bot-causal-worker');
const { policyImplementationId } = require('./build-long-bot-engine');
const ROOT = path.join(__dirname, '..');
const VERSION = 'long-board-model-review-v1';
const WEIGHTS = Object.freeze({ opponentHeadFreedom:48000, headLandingExposure:62000,
  headRelease:9800, foothold:4300, homeEntry:145000, rushPenalty:12500,
  trapRisk:62000, escapeGatewayRisk:800000, distribution:780 });
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function identity({ production = false } = {}) {
  const files = [...runtimeClosureFiles().map(([name]) => name), 'scripts/long-bot-board-model-worker.js'].sort();
  const h = createHash('sha256').update(`${VERSION}\0${process.version}\0${process.versions.v8}\0`);
  for (const name of files) {
    const file = path.join(ROOT, name), stat = fs.lstatSync(file);
    if (production && (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || stat.nlink !== 1
      || fs.realpathSync(file) !== file)) throw Error('Board reviewer closure is not immutable');
    h.update(name).update('\0').update(fs.readFileSync(file)).update('\0');
  }
  const { engine } = loadRuntime();
  if (engine.policyImplementationId !== policyImplementationId()) throw Error('Stale generated policy');
  return { runtimeDigest:h.digest('hex'), policyImplementationId:engine.policyImplementationId };
}
function replayFinishedHistory(finalState, botColor, runtime = loadRuntime()) {
  const { game } = runtime;
  if (finalState?.variant !== 'long' || !['white','dark'].includes(botColor)
    || finalState.winner !== game.opponentOf(botColor) || finalState.off?.[finalState.winner] !== 15
    || !Array.isArray(finalState.history) || finalState.history.length > 1500) throw Error('Not a complete long loss');
  const state = game.initialState('long');
  let start = null, moves = [], opening = false;
  const turns = [];
  const flush = () => {
    if (!start) return;
    const legal = game.bestMoveSequences(start, start.turn);
    if (!legal.some(q => canonicalMoveKey(q) === canonicalMoveKey(moves))
      && (moves.length || legal.some(q => q.length))) throw Error('Incomplete maximum-use history turn');
    if (start.turn === botColor) turns.push({ state:stateFromSnapshot(start), executedMoves:canonicalMoves(moves) });
    game.endTurn(state); start = null; moves = [];
  };
  for (const event of [...finalState.history].reverse()) {
    if (event.opening) {
      if (opening || start || !['white','dark'].includes(event.winnerColor)) throw Error('Invalid opening ledger');
      opening = true; state.turn = event.winnerColor; continue;
    }
    if (event.roll) {
      flush();
      if (!opening || state.winner || event.color !== state.turn || !/^[1-6]:[1-6]$/.test(event.roll)) throw Error('Invalid roll ledger');
      const [a,b] = event.roll.split(':').map(Number);
      state.dice = a === b ? [a,a,a,a] : [a,b]; state.rolled = [...state.dice]; state.phase = 'move';
      state.history = []; start = structuredClone(state); continue;
    }
    if (event.from === undefined) continue;
    if (!start || event.color !== state.turn || !Number.isInteger(event.from) || !Number.isInteger(event.die)) throw Error('Invalid move ledger');
    const to = game.moveTo(state.turn, event.from, event.die, state);
    if ((event.to === 'снято' ? 0 : event.to) !== to
      || !game.applyMove(state, event.from, event.die, { autoEnd:false })) throw Error('Illegal historical move');
    moves.push({ from:event.from, to, die:event.die });
  }
  flush();
  if (!turns.length || state.winner !== finalState.winner || afterPositionKey(state) !== afterPositionKey(finalState)) throw Error('Replayed final board mismatch');
  return turns;
}
function liveOptions(state) {
  return { strategyProfile:'v26', weights:WEIGHTS,
    ...(state.dice.length === 4 ? { maxCandidates:16, initialSequenceLimit:16,
      maxTacticalCandidates:2, analysisNodeBudget:58 } : { maxCandidates:64, analysisNodeBudget:480 }) };
}
let imports;
async function teacherModules() {
  return imports ||= Promise.all(['analysis','nardu-game-adapter','evaluator'].map(name =>
    import(pathToFileURL(path.join(ROOT, 'bot-engine/long', `${name}.ts`)).href)));
}
async function reviewTurn(turn, source, turnIndex, id = identity(), options = {}) {
  const { game, engine } = loadRuntime();
  const [analysis, { createNarduGameAdapter }, { mergeWeights }] = await teacherModules();
  const { analyzeOpponentReplies, assessLongBotSituation, createAnalysisBudget, adaptiveReplyUtility } = analysis;
  const adapter = createNarduGameAdapter(game, { generatedSequenceFastPath:true });
  const state = turn.state, runtimeOptions = liveOptions(state), deadline = Date.now() + (options.maxElapsedMs || 90000);
  engine.setExperience([], 'server');
  const cold = engine.rank(state, runtimeOptions)[0];
  if (!cold) return { status:'forced-pass', turnIndex };
  const unique = new Map();
  for (const sequence of game.bestMoveSequences(state, state.turn)) {
    const after = applyLegalSequence(game, state, sequence);
    if (!after) throw Error('Native legal sequence failed replay');
    const key = afterPositionKey(after);
    if (unique.has(key)) continue;
    if (unique.size >= 64) return { status:'capacity', turnIndex };
    const described = engine.describeSequence(state, sequence, runtimeOptions);
    unique.set(key, { after, sequence, score:0, features:described.features, experience:described.experience });
  }
  const candidates = [...unique.values()];
  if (candidates.length < 2) return { status:'forced-board', turnIndex };
  const situation = assessLongBotSituation(state, state.turn);
  // Exhaust every admitted root resulting board and all 21 dice outcomes.
  // Opponent actions use the explicitly named bounded native reply model.
  // Budgets stop after primary replies: conditional deep proxy frontiers are
  // not misrepresented as complete nested game-tree coverage.
  for (let i=0; i<candidates.length; i+=4) {
    if (Date.now() > deadline) return { status:'capacity', turnIndex };
    const batch = candidates.slice(i,i+4);
    analyzeOpponentReplies(adapter, state.turn, batch, mergeWeights(WEIGHTS),
      createAnalysisBudget(batch.length*21), { expandDoubles:true, situation });
  }
  if (candidates.some(c => !c.tactical?.distributionComplete || c.tactical.rolls !== 21
    || c.tactical.distributionWeight !== 36)) throw Error('Incomplete teacher dice coverage');
  const baseline = candidates.find(c => afterPositionKey(c.after) === afterPositionKey(cold.after));
  if (!baseline) throw Error('Cold baseline missing');
  const utility = c => adaptiveReplyUtility(c.tactical, situation);
  const alternatives = candidates.filter(c => c !== baseline
    && Number(c.features.resultSafetyAfter || 0) >= Number(cold.features.resultSafetyAfter || 0)
    && Number(c.features.startZoneReduction || 0) >= Number(cold.features.startZoneReduction || 0)
    && c.tactical.expectedEquity >= baseline.tactical.expectedEquity + 0.025
    && utility(c) >= utility(baseline) + 0.025
    && c.tactical.lowerTailEquity >= baseline.tactical.lowerTailEquity - 0.06)
    .sort((a,b) => utility(b)-utility(a) || canonicalMoveKey(a.sequence).localeCompare(canonicalMoveKey(b.sequence)));
  const measurements = c => ({ expectedEquity:c.tactical.expectedEquity, utility:utility(c),
    lowerTailEquity:c.tactical.lowerTailEquity, selfEvaluation:c.tactical.expectedSelfEvaluation,
    opponentEvaluation:c.tactical.expectedOpponentEvaluation });
  for (const recommended of alternatives) {
    const lesson = { creditVersion:10, evidenceSchema:'long-server-board-model-pattern-v1',
      trustDomain:'nardu/server-long-bot-board-model/v1', reviewerVersion:VERSION,
      scoreSemantics:'heuristic-turn-equity-v1', opponentReplyModel:'best-of-bounded-legal-replies-v1',
      ...id, positionKey:engine.boardLessonPositionKey(state),
      contextKey:cold.experience.contextKey, actionKey:cold.experience.actionKey,
      preferredActionKey:recommended.experience.actionKey, preferredMoves:canonicalMoves(recommended.sequence),
      utilityGain:utility(recommended)-utility(baseline),
      equityGain:recommended.tactical.expectedEquity-baseline.tactical.expectedEquity,
      diceOutcomes:21, diceWeight:36, rootPositions:candidates.length,
      sourceRoom:source.roomCode, sourceArchiveId:source.archiveId, sourceFingerprint:source.fingerprint,
      sourcePolicyImplementationId:source.sourcePolicyImplementationId || null, turnIndex,
      samples:1, losses:0, wins:0, outcomeUsed:false, terminalOutcomeConfirmed:false,
      baseline:measurements(baseline), recommended:measurements(recommended),
      historicalExecutedMoves:turn.executedMoves, baselineMoves:canonicalMoves(cold.sequence) };
    lesson.aggregateId = sha(stableStringify(lesson));
    if (!engine.validBoardModelLesson(lesson)) throw Error('Invalid native lesson');
    engine.setExperience([lesson], 'server');
    const learned = engine.rank(state, runtimeOptions)[0];
    engine.setExperience([], 'server');
    if (learned?.features.boardModelLessonApplied === 1
      && afterPositionKey(learned.after) === afterPositionKey(recommended.after)) {
      // Native rank adds opportunity-relative koks/home annotations which a
      // single described sequence cannot know. Preserve the actual applied key.
      lesson.preferredActionKey = learned.experience.actionKey;
      delete lesson.aggregateId;
      lesson.aggregateId = sha(stableStringify(lesson));
      return { status:'model-reviewed', turnIndex, lesson,
        coverage:{rootPositions:candidates.length,diceOutcomes:21,diceWeight:36},
        coldAction:canonicalMoveKey(cold.sequence), learnedAction:canonicalMoveKey(learned.sequence) };
    }
  }
  return { status:'no-applicable-improvement', turnIndex, rootPositions:candidates.length };
}
async function runOnce({ rooms = null, maxTurns = 2 } = {}) {
  const id = identity({ production:true });
  const rpc = (name,args) => supabaseRpc(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,name,args);
  let source = await rpc('next_long_bot_board_review', { p_policy:id.policyImplementationId,
    p_runtime:id.runtimeDigest, p_rooms:rooms });
  if (!source && rooms) source = await rpc('next_long_bot_board_review', {
    p_policy:id.policyImplementationId,p_runtime:id.runtimeDigest,p_rooms:null });
  if (!source) return { reviewerVersion:VERSION, ...id, reviewed:0, lessons:0 };
  let turns;
  try {
    turns = replayFinishedHistory(source.finalState, source.botColor);
    if (turns.length > 240) throw Error('History turn capacity');
  } catch (error) {
    await rpc('quarantine_long_bot_board_review', { p_archive_id:source.archiveId,
      p_fingerprint:source.fingerprint,p_policy:id.policyImplementationId,
      p_runtime:id.runtimeDigest,p_reason:error.message.slice(0,200) });
    return { ...id,roomCode:source.roomCode,quarantined:true,reviewed:0,lessons:0 };
  }
  let cursor = source.reviewedTurns, count=0, lessons=0;
  const started=Date.now();
  while (cursor < turns.length && count < maxTurns && Date.now()-started < 180000) {
    const review = await reviewTurn(turns[cursor], source, cursor, id);
    const receipt = await rpc('checkpoint_long_bot_board_review', { p_archive_id:source.archiveId,
      p_fingerprint:source.fingerprint, p_policy:id.policyImplementationId, p_runtime:id.runtimeDigest,
      p_previous:cursor, p_total:turns.length, p_review:review });
    if (receipt.reviewedTurns !== cursor+1) throw Error('Board review checkpoint rejected');
    cursor++; count++; if (review.lesson) lessons++;
  }
  return { reviewerVersion:VERSION,...id,roomCode:source.roomCode,reviewed:count,
    reviewedTurns:cursor,totalTurns:turns.length,lessons };
}
if (require.main === module) {
  (async () => {
    const args=process.argv.slice(2);
    if (args[0]==='--identity' && args.length===1) return identity();
    if (args[0]!=='--once' || args.length>2) throw Error('Use --identity or --once [ROOM1,ROOM2]');
    return runOnce({ rooms:args[1]?args[1].split(','):null });
  })().then(r=>process.stdout.write(JSON.stringify(r)+'\n')).catch(e=>{console.error(`Board review failed: ${e.message}`);process.exitCode=1;});
}
module.exports={ VERSION, WEIGHTS, identity, replayFinishedHistory, liveOptions, reviewTurn, runOnce };
